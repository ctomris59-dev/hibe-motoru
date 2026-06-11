/**
 * scraper.js - AI Agent Destekli Hibe & Teşvik Motoru
 * Kurum sitelerindeki ilanları Gemini AI ile analiz eder ve data.json dosyasını günceller.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { GoogleGenAI } = require('@google/genai');
const cheerio = require('cheerio');

// GitHub Actions Secrets'tan gelen API Key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const DATA_PATH = path.join(__dirname, '../data.json');

const KAYNAKLAR = [
  { id: 'kosgeb', ad: 'KOSGEB', url: 'https://www.kosgeb.gov.tr/site/tr/genel/destekler/3/destek-programlari' },
  { id: 'tubitak', ad: 'TÜBİTAK TEYDEB', url: 'https://www.tubitak.gov.tr/tr/destekler/sanayi/ulusal-destek-programlari' },
  { id: 'tkdk', ad: 'TKDK / IPARD', url: 'https://www.tkdk.gov.tr/Sayfa/Duyurular' },
  { id: 'trakyaka', ad: 'TRAKYA KA', url: 'https://www.trakyaka.org.tr/tr/destekler/acik-destek-programlari' },
  { id: 'ticaret', ad: 'Ticaret Bakanlığı', url: 'https://www.ticaret.gov.tr/destekler' },
  { id: 'sanayi', ad: 'Sanayi ve Teknoloji Bakanlığı', url: 'https://www.sanayi.gov.tr/destekler-ve-teşvikler' }
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HibeMotoru/2.0' },
      timeout: 15000
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function temizMetinCikar(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().substring(0, 15000);
}

async function aiIleIlanlariCoz(kaynakAd, kaynakUrl, sayfaMetni) {
  const prompt = `
    Sen bir TSO hibe ve teşvik uzmanı yapay zekasısın.
    Aşağıda sana "${kaynakAd}" kurumuna ait resmi web sitesinin güncel metin içeriği verilecek.
    Bu metni incele ve şu an BAŞVURUYA AÇIK olan veya YENİ DUYURULAN hibe, teşvik, destek programlarını tespit et.

    Senden SADECE aşağıdaki JSON formatında bir array döndürmeni istiyorum. Başka hiçbir açıklama yazma.
    
    Her ilan için:
    - baslik: İlanın tam adı
    - tur: "Hibe", "Yatırım Teşviki", "Kredi/Finansman", "Vergi/SGK Teşviki" değerlerinden biri.
    - grup: Genel kategori adı (Örn: "KOBİ Destekleri", "Ar-Ge ve İnovasyon")
    - sektor: Yararlanabilecek sektörler listesi array olarak. Her sektöre uygunsa ["Tüm Sektörler"] yaz.
    - tutar: Destek bütçesi veya oranı. Bulamazsan "Belirtilmemiş" yaz.
    - son: Son başvuru tarihi. YYYY-MM-DD formatında yaz. Sürekli açıksa "Süresiz" yaz.
    - aciklama: Maksimum 2 cümlelik kısa özet.
    - url: İlanın tam linki veya "${kaynakUrl}"

    DÖNDÜRECEĞİN FORMAT SADECE BU OLMALI (Markdown bloğu olmadan düz JSON):
    [
      {
        "baslik": "Örnek Program",
        "tur": "Hibe",
        "grup": "KOBİ Destekleri",
        "sektor": ["Üretim", "Teknoloji"],
        "tutar": "1.000.000 ₺",
        "son": "2026-12-31",
        "aciklama": "Açıklama cümlesi.",
        "url": "${kaynakUrl}"
      }
    ]
    Eğer aktif/yeni hiçbir ilan yoksa sadece boş liste döndür: []

    İNCELENECEK METİN:
    ${sayfaMetni}
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });
    const temizJsonText = response.text.replace(/```json|```/g, '').trim();
    return JSON.parse(temizJsonText);
  } catch (error) {
    console.error(`    ❌ AI Analiz Hatası (${kaynakAd}):`, error.message);
    return [];
  }
}

async function anaMotor() {
  console.log('🤖 AI Agent Hibe Tarama Motoru Başlatıldı...');
  let mevcutVeri = [];
  if (fs.existsSync(DATA_PATH)) {
    mevcutVeri = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  }

  let yeniEklendiSayisi = 0;
  let guncellendiSayisi = 0;
  const buTurdaBulunanUrlListesi = [];

  for (const kaynak of KAYNAKLAR) {
    console.log(`\n🌐 ${kaynak.ad} taranıyor...`);
    try {
      const { body } = await fetchUrl(kaynak.url);
      const ayiklanmisMetin = temizMetinCikar(body);
      const aiIlanlari = await aiIleIlanlariCoz(kaynak.ad, kaynak.url, ayiklanmisMetin);
      
      aiIlanlari.forEach(yeniIlan => {
        buTurdaBulunanUrlListesi.push(yeniIlan.url);
        const eskiIndeks = mevcutVeri.findIndex(p => p.url === yeniIlan.url || p.baslik === yeniIlan.baslik);

        if (eskiIndeks === -1) {
          const yeniId = mevcutVeri.length > 0 ? Math.max(...mevcutVeri.map(p => p.id)) + 1 : 1;
          mevcutVeri.unshift({
            id: yeniId,
            ...yeniIlan,
            kaynak: kaynak.ad,
            durum: 'açık'
          });
          yeniEklendiSayisi++;
          console.log(`    🆕 YENİ İLAN: ${yeniIlan.baslik}`);
        } else {
          mevcutVeri[eskiIndeks] = {
            ...mevcutVeri[eskiIndeks],
            son: yeniIlan.son,
            tutar: yeniIlan.tutar,
            aciklama: yeniIlan.aciklama,
            durum: 'açık'
          };
          guncellendiSayisi++;
        }
      });
    } catch (err) {
      console.error(`  ❌ Tarama hatası (${kaynak.ad}):`, err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Siteden tamamen kaldırılan eski ilanları "kapandı" yapma
  mevcutVeri = mevcutVeri.map(p => {
    const kaynakTarananlardanMi = KAYNAKLAR.some(k => k.ad === p.kaynak);
    if (kaynakTarananlardanMi && p.durum === 'açık' && !buTurdaBulunanUrlListesi.includes(p.url)) {
      console.log(`  🗑️  Siteden kaldırıldığı için kapandı: ${p.baslik}`);
      return { ...p, durum: 'kapandı' };
    }
    return p;
  });

  fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutVeri, null, 2), 'utf8');
  console.log(`\n✅ İşlem Tamamlandı. ${yeniEklendiSayisi} yeni, ${guncellendiSayisi} güncellenen ilan.`);
}

anaMotor();
