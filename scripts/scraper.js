/**
 * scraper.js — Çorlu TSO Hibe Motoru
 * * Tüm RSS kaynaklarını toplar → TEK bir Gemini isteğiyle analiz eder.
 * Günlük kota kullanımı: 1 istek (önceki versiyonda 6 istek)
 * * Gerekli GitHub Secrets:
 * GEMINI_API_KEY, BILDIRIM_EMAIL (ops.), RESEND_API_KEY (ops.)
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('❌ GEMINI_API_KEY bulunamadı!'); process.exit(1); }

const DATA_PATH      = path.join(__dirname, '../data.json');
const RAPOR_PATH     = path.join(__dirname, 'rapor.json');
const BILDIRIM_EMAIL = process.env.BILDIRIM_EMAIL || '';
const RESEND_KEY     = process.env.RESEND_API_KEY  || '';

// ─── Google News RSS kaynakları ───────────────────────────────────────────────
const KAYNAKLAR = [
  { ad: 'KOSGEB',             url: 'https://news.google.com/rss/search?q=KOSGEB+hibe+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TÜBİTAK',            url: 'https://news.google.com/rss/search?q=TUBITAK+TEYDEB+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Ticaret Bakanlığı',   url: 'https://news.google.com/rss/search?q=Ticaret+Bakanligi+ihracat+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Sanayi Bakanlığı',    url: 'https://news.google.com/rss/search?q=Sanayi+ve+Teknoloji+Bakanligi+tesvik+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Kalkınma Ajansı',     url: 'https://news.google.com/rss/search?q=Kalkinma+Ajansi+proje+teklif+cagrisi+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Yatırım Teşvik',     url: 'https://news.google.com/rss/search?q=yatirim+tesvik+belgesi+resmi+gazete+2026&hl=tr&gl=TR&ceid=TR:tr' }
];

const GRUPLAR = [
  "Hibe Programları","Yatırım Teşvikleri","İhracat ve Uluslararasılaşma",
  "İhracat Finansmanı (Eximbank)","Kredi Garantisi (KGF)","Uygun Faizli Krediler",
  "AB ve Uluslararası Hibeler","Bölgesel Kalkınma (Ajanslar)","Vergi ve SGK Avantajları",
  "İstihdam ve Personel Destekleri","Tarım Destekleri","Enerji ve Yeşil Dönüşüm",
  "Turizm Destekleri","Savunma Sektörü"
];

const rapor = { tarih: new Date().toISOString(), basarili: 0, hata: 0, detaylar: [], yeniEklenen: 0, toplamProgram: 0 };

async function main() {
  console.log('🤖 AI Agent: RSS kaynakları taranıyor...');
  let hamMetin = '';

  for (const k of KAYNAKLAR) {
    try {
      const xml = await httpGet(k.url);
      const maddeler = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      rapor.detaylar.push({ kaynak: k.ad, maddeSayisi: maddeler.length });
      
      maddeler.slice(0, 10).forEach(m => {
        const title = m.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
        const link  = m.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
        const desc  = m.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
        hamMetin += `Kaynak: ${k.ad}\nBaşlık: ${title}\nLink: ${link}\nÖzet: ${desc}\n${'─'.repeat(20)}\n`;
      });
      rapor.basarili++;
    } catch (e) {
      console.error(`   ❌ ${k.ad} çekilemedi: ${e.message}`);
      rapor.detaylar.push({ kaynak: k.ad, hata: e.message });
      rapor.hata++;
    }
  }

  // Güvence Önlemi: Eğer RSS akışları o gün boş kalırsa KOSGEB'in güncel çağrısı asla kaybolmasın
  hamMetin += `\nKaynak: KOSGEB\nBaşlık: Kapasite Geliştirme Destek Programı 2026 Yılı 2. Dönem Çağrısı Başladı\nLink: https://www.kosgeb.gov.tr/site/tr/duyuru/detay/9274/kapasite-gelistirme-destek-programi-2026-yili-2-donem-proje-teklif-cagrisi\nÖzet: Uzay, havacılık, savunma, yüksek teknoloji ve imalat sektöründeki KOBİ'lere yönelik %70 hibe ve uygun finansman desteği. Son başvuru tarihi 30 Haziran 2026.\n${'─'.repeat(20)}\n`;

  // ── Veritabanını Oku ─────────────────────────────────────────────────────────
  let mevcutData = [];
  if (fs.existsSync(DATA_PATH)) {
    try { mevcutData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]'); } catch(e) { mevcutData = []; }
  }

  // ── Gemini ile Tek İstekte Analiz ────────────────────────────────────────────
  console.log('🤖 AI Agent: Tek istek halinde Gemini analizine gönderiliyor...');
  
  const prompt = `
    Aşağıdaki ham metni incele ve Türkiye'deki hibe/destek programlarını analiz et.
    Mevcut veritabanımız şudur: ${JSON.stringify(mevcutData)}
    
    KURALLAR:
    1. Eğer yeni bir çağrı/ilan tespit edersen ve mevcut listede YOKSA, yeni bir program nesnesi olarak listeye EKLE.
    2. SİLME KURALI: Mevcut listedeki ilanları asla silme! Eğer bir ilanın süresi geçmişse veya kapandıysa, o ilanın "durum" alanını 'kapandı' yap. Yaklaşanlar için 'kapanmak üzere' veya 'açık' olarak güncelle.
    3. LINK KURALI (KRİTİK): Ekleyeceğin veya güncelleyeceğin hibe nesnesinin "url" alanına kesinlikle sadece kurumun ana sayfa adresini (Örn: "https://www.kosgeb.gov.tr" veya "https://www.tubitak.gov.tr") yazma! Ham metinde o ilana ait paylaşılan spesifik detay linki veya Google News yönlendirme URL'si ne ise, "url" alanına birebir O DETAY LİNKİNİ yaz. Eğer hiçbir spesifik yönlendirme linki bulamazsan, kullanıcının o ilanı kurum içinde doğrudan bulabilmesi için arama parametreli akıllı kurumsal linkler türet.
    4. "grup" alanı kesinlikle şu listeden biri olmalı: ${JSON.stringify(GRUPLAR)}
    5. "sektor" alanı bir dizi (array) olmalı. Örn: ["İmalat", "Teknoloji"]. Eğer ayrım yoksa ["Tüm Sektörler"] yap.
    6. "son" alanı son başvuru tarihi olmalı (YYYY-MM-DD formatında). Eğer tarih yoksa 'Süresiz' yaz.
    7. Çıktıyı SADECE yeni eklenmiş ve durumu güncellenmiş TÜM ilanları içeren nihai tek bir JSON dizi (array) formatında ver. Başında veya sonunda asla markdown kod blokları (\`\`\`json) ya da açıklama yazısı olmasın. Direct array döndür.

    Ham Kaynak Metin:
    ${hamMetin}
  `;

  let yeniProgramlar = [];
  try {
    const aiResult = await geminiGenerate(prompt);
    let temizJson = aiResult.trim();
    if (temizJson.startsWith('```')) {
      temizJson = temizJson.replace(/```json|```/gi, '').trim();
    }

    const yeniDizi = JSON.parse(temizJson);
    if (Array.isArray(yeniDizi)) {
      // Değişiklikleri mevcut veritabanına yedirelim
      yeniProgramlar = yeniDizi.filter(p => !mevcutData.some(m => m.baslik === p.baslik));
      
      if (yeniProgramlar.length === 0) {
        console.log('   Tespit edilenler zaten listede var veya sadece durumlar güncellendi.');
        mevcutData = yeniDizi; // Durum güncellemelerini yansıt
      } else {
        let nextId = mevcutData.length > 0 ? Math.max(...mevcutData.map(d=>d.id||0))+1 : 1;
        yeniProgramlar.forEach(p => { 
          p.id = nextId++; 
          mevcutData.push(p); 
        });
        console.log(`   ✅ ${yeniProgramlar.length} yeni program eklendi:`);
        yeniProgramlar.forEach(p => console.log(`      + ${p.baslik} (son: ${p.son})`));
      }
    }
  } catch(e) {
    console.error(`   ❌ Gemini hatası: ${e.message}`);
    rapor.geminiHata = e.message;
  }

  // ── Kaydet ───────────────────────────────────────────────────────────────────
  fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutData, null, 2), 'utf8');
  rapor.yeniEklenen = yeniProgramlar.length;
  rapor.toplamProgram = mevcutData.length;
  fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2), 'utf8');

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 SONUÇ: ${mevcutData.length} program, ${yeniProgramlar.length} yeni eklendi`);
  console.log(`   Açık: ${mevcutData.filter(d => d.durum === 'açık').length}, Kapanmak Üzere: ${mevcutData.filter(d => d.durum === 'kapanmak üzere').length}`);
  
  // ── E-Posta Bildirimi (Opsiyonel) ─────────────────────────────────────────────
  if (RESEND_KEY && BILDIRIM_EMAIL && yeniProgramlar.length > 0) {
    await ePostaGonder(yeniProgramlar);
  }
}

// ─── Yardımcı Fonksiyonlar ─────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function geminiGenerate(prompt) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const resJson = JSON.parse(body);
          if (resJson.error) return reject(new Error(resJson.error.message));
          const txt = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!txt) return reject(new Error('Boş Gemini yanıtı'));
          resolve(txt);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function ePostaGonder(yeniList) {
  return new Promise((resolve) => {
    let html = `<h2>🔔 Hibe Teşvik Radar — Yeni Teşvikler Tespit Edildi!</h2>`;
    yeniList.forEach(p => {
      html += `<p><strong>${p.baslik}</strong><br/>Kaynak: ${p.kaynak} | Son Gün: ${p.son}<br/>Tutar: ${p.tutar}<br/><a href="${p.url}">Detaylı Bilgi İçin Tıklayın</a></p><hr/>`;
    });
    
    const postData = JSON.stringify({
      from: 'Hibe Radar <onboarding@resend.dev>',
      to: [BILDIRIM_EMAIL],
      subject: `🔔 ${yeniList.length} Yeni Hibe/Teşvik İlanı Tespit Edildi!`,
      html: html
    });

    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };

    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => { console.log('   📧 Üye bilgilendirme e-postası tetiklendi.'); resolve(); });
    });
    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

main();
