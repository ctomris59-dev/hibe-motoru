/**
 * scraper.js - AI Agent Destekli Hibe & Teşvik Motoru
 * Her Pazartesi çalışır. Kaynak sitelerdeki yeni/güncel ilanları AI ile analiz eder,
 * data.json dosyasını otomatik besler ve günceller.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { GoogleGenAI } = require('@google/genai');
const cheerio = require('cheerio');

// GitHub Actions üzerinde tanımlayacağınız Gemini API Key
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

// Güvenli URL Fetch Fonksiyonu
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

// Sayfadaki saf metinleri ve olası linkleri temizleme
function temizMetinCikar(html) {
  const $ = cheerio.load(html);
  // Script, style ve nav gibi gereksiz alanları uçur
  $('script, style, nav, footer, header, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().substring(0, 15000); // İlk 15k karakter yeterli
}

// Gemini AI Agent İstek Motoru
async function aiIleIlanlariCoz(kaynakAd, kaynakUrl, sayfaMetni) {
  const prompt = `
    Sen bir TSO (Ticaret ve Sanayi Odası) hibe ve teşvik uzmanı yapay zekasısın.
    Aşağıda sana "${kaynakAd}" kurumuna ait resmi web sitesinin güncel metin içeriği verilecek.
    Bu metni incele ve şu an BAŞVURUYA AÇIK olan veya YENİ DUYURULAN hibe, teşvik, destek programlarını veya çağrılarını tespit et.

    Senden SADECE aşağıdaki JSON formatında bir array (liste) döndürmeni istiyorum. Başka hiçbir açıklama yazma.
    
    Her bir ilan için çıkarmalısın:
    - baslik: İlanın tam adı
    - tur: "Hibe", "Yatırım Teşviki", "Kredi/Finansman", "Vergi/SGK Teşviki" ya da "Ödül/Yarışma" değerlerinden biri olmalı.
    - grup: Genel kategori adı (Örn: "KOBİ Destekleri", "Ar-Ge ve İnovasyon", "Bölgesel Destekler")
    - sektor: Bu destekten yararlanabilecek sektörler listesi array olarak. Her sektöre uygunsa ["Tüm Sektörler"] yaz.
    - tutar: Destek bütçesi veya oranı (Örn: "2.000.000 ₺'ye kadar" veya "%75 Destek"). Bulamazsan "Belirtilmemiş" yaz.
    - son: Son başvuru tarihi. Eğer metinden net bir tarih çıkıyorsa YYYY-MM-DD formatında yaz (Örn: "2026-08-15"). Eğer süre sınırı yoksa veya sürekli açıksa "Süresiz" yaz.
    - aciklama: Programın amacını ve kimlerin başvurabileceğini anlatan maksimum 2 cümlelik kısa özet.
    - url: İlanın detayına giden link. Eğer metinde spesifik link yoksa direkt ana kaynağın linkini yaz: "${kaynakUrl}"

    DÖNDÜRECEĞİN FORMAT SADECE BU OLMALI (Markdown kod bloğu olmadan, düz metin JSON):
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

    Eğer sayfada şu an aktif/yeni hiçbir ilan yoksa sadece boş bir liste döndür: []

    İNCELENECEK WEB SİTESİ METNİ:
    ${sayfaMetni}
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Hızlı, ucuz ve yapısal çıktı yeteneği yüksek model
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
  
  // Bulunan tüm ilanların URL'lerini bu turda aktif tutmak için kaydedeceğiz
  const buTurdaBulunanUrlListesi = [];

  for (const kaynak of KAYNAKLAR) {
    console.log(`\n🌐 ${kaynak.ad} taranıyor... (${kaynak.url})`);
    try {
      const { body } = await fetchUrl(kaynak.url);
      const ayiklanmisMetin = temizMetinCikar(body);
      
      console.log(`  🧠 AI Agent içeriği analiz ediyor...`);
      const aiIlanlari = await aiIleIlanlariCoz(kaynak.ad, kaynak.url, ayiklanmisMetin);
      
      console.log(`  📊 AI sayfada ${aiIlanlari.length} aktif program tespit etti.`);

      aiIlanlari.forEach(yeniIlan => {
        buTurdaBulunanUrlListesi.push(yeniIlan.url);
        
        // Bu ilan veritabanımızda zaten var mı? (Başlık veya URL kontrolü)
        const eskiIndeks = mevcutVeri.findIndex(p => p.url === yeniIlan.url || p.baslik === yeniIlan.baslik);

        if (eskiIndeks === -1) {
          // TAMAMEN YENİ İLAN DETECT EDİLDİ
          const yeniId = mevcutVeri.length > 0 ? Math.max(...mevcutVeri.map(p => p.id)) + 1 : 1;
          const eklenecekIlan = {
            id: yeniId,
            ...yeniIlan,
            kaynak: kaynak.ad,
            durum: yeniIlan.son === 'Süresiz' ? 'açık' : 'açık' // İlk açılışta açık
          };
          
          // Listenin en başına ekle (yeni duyurular üstte görünsün)
          mevcutVeri.unshift(eklenecekIlan);
          yeniEklendiSayisi++;
          console.log(`    🆕 YENİ DETECTED: ${yeniIlan.baslik}`);
        } else {
          // İLAN ZATEN VAR, AI VERİSİNE GÖRE GÜNCELLE (Örn: Tarih veya açıklama değişmiş olabilir)
          mevcutVeri[eskiIndeks] = {
            ...mevcutVeri[eskiIndeks],
            son: yeniIlan.son,
            tutar: yeniIlan.tutar,
            aciklama: yeniIlan.aciklama,
            durum: 'açık' // Sitede hala listelendiği için durumunu açık tut
          };
          guncellendiSayisi++;
        }
      });

    } catch (err) {
      console.error(`  ❌ Kaynak tarama hatası (${kaynak.ad}):`, err.message);
    }
    
    // Bloklanmamak için kaynaklar arası kısa bekleme
    await new Promise(r => setTimeout(r, 2000));
  }

  // ─── OTOMATİK KAPANANLARI TESPİT ETME (KAYBOLAN İLANLAR) ───────────────────
  // Eğer data.json içinde durumu "açık" olan bir ilan, bu tarama turunda 
  // ilgili kurumun sayfasında HİÇ listelenmediyse, o ilan muhtemelen yayından kalkmıştır (kapanmıştır).
  mevcutVeri = mevcutVeri.map(p => {
    // Sadece taradığımız kaynaklara ait olan ve şu an açık görünen ilanları kontrol et
    const kaynakTarananlardanMi = KAYNAKLAR.some(k => k.ad === p.kaynak);
    if (kaynakTarananlardanMi && p.durum === 'açık' && !buTurdaBulunanUrlListesi.includes(p.url)) {
      console.log(`  🗑️  Siteden kaldırıldığı için kapandı olarak işaretlendi: ${p.baslik}`);
      return { ...p, durum: 'kapandı' };
    }
    return p;
  });

  // Güncel veriyi data.json dosyasına yaz
  fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutVeri, null, 2), 'utf8');

  console.log(`\n✅ Tarama Raporu: ${yeniEklendiSayisi} yeni ilan eklendi, ${guncellendiSayisi} ilan güncellendi.`);
}

anaMotor();
