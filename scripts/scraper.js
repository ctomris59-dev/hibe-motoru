/**
 * scraper.js — Çorlu TSO Hibe Motoru
 * 
 * Tüm RSS kaynaklarını toplar → TEK bir Gemini isteğiyle analiz eder.
 * Günlük kota kullanımı: 1 istek
 * 
 * Gerekli GitHub Secrets:
 *   GEMINI_API_KEY, BILDIRIM_EMAIL (ops.), RESEND_API_KEY (ops.)
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

// ─── Bilinen ana sayfalar — spesifik URL yoksa Google araması yap ──────────
const ANASAYFA_PATTERN = [
  /^https?:\/\/(www\.)?kosgeb\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?tubitak\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?sanayi\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?ticaret\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?iskur\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?sgk\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?hmb\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?kgf\.com\.tr\/?$/,
  /^https?:\/\/(www\.)?eximbank\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?kalkinma\.com\.tr\/?$/,
  /^https?:\/\/(www\.)?tarimorman\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?trakyaka\.org\.tr\/?$/,
  /^https?:\/\/(www\.)?ssb\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?tesk\.org\.tr\/?$/,
  /^https?:\/\/(www\.)?tkdk\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?csb\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?epdk\.gov\.tr\/?$/,
  /^https?:\/\/(www\.)?yegm\.gov\.tr\/?$/,
];

/**
 * urlDogru — Ana sayfa URL'lerini tespit eder, gerçek program URL'sine yönlendirir.
 * Eğer URL bir ana sayfa ise Google araması URL'si döndürür.
 * @param {string} url   - Gemini'den gelen URL
 * @param {string} baslik - Program başlığı (arama sorgusu için)
 * @param {string} kaynak - Kaynak kurum adı (arama sorgusu için)
 * @returns {string}
 */
function urlDogru(url, baslik, kaynak) {
  if (!url || url.trim() === '') {
    const sorgu = encodeURIComponent(`${baslik} ${kaynak} başvuru 2026`);
    return `https://www.google.com/search?q=${sorgu}`;
  }

  const isAnaSayfa = ANASAYFA_PATTERN.some(r => r.test(url.trim()));
  if (isAnaSayfa) {
    const sorgu = encodeURIComponent(`${baslik} ${kaynak} başvuru 2026`);
    return `https://www.google.com/search?q=${sorgu}`;
  }

  return url.trim();
}

/**
 * googleAramaLinki — Bir kayıt için Google arama linki üretir (fallback).
 */
function googleAramaLinki(baslik, kaynak) {
  const sorgu = encodeURIComponent(`${baslik} ${kaynak} başvuru 2026`);
  return `https://www.google.com/search?q=${sorgu}`;
}

/**
 * linkCalisiyorMu — Bir URL'in gerçekten açılıp açılmadığını kontrol eder.
 * - 404/410/5xx  → kırık
 * - 200 ama ana sayfaya redirect olmuş (ANASAYFA_PATTERN) → kırık
 * - 200 ve farklı bir sayfa → çalışıyor
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function linkCalisiyorMu(url) {
  return new Promise((resolve) => {
    try {
      const req = https.request(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CorlutsoBot/2.0)' },
        timeout: 10000
      }, res => {
        // Bazı siteler HEAD'i desteklemiyor (405/501) → GET ile tekrar dene
        if (res.statusCode === 405 || res.statusCode === 501) {
          fetchUrl(url, 10000).then(({ status }) => {
            if (status >= 400) return resolve(false);
            resolve(true);
          }).catch(() => resolve(false));
          return;
        }
        if (res.statusCode >= 400) return resolve(false);

        // Redirect zinciri en sonunda ana sayfaya mı düştü, kontrol et
        const finalUrl = res.headers.location || url;
        const anaSayfayaDustu = ANASAYFA_PATTERN.some(r => r.test(finalUrl.trim()));
        resolve(!anaSayfayaDustu);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * kirikLinkleriDuzelt — mevcutData içindeki kayıtların URL'lerini kontrol eder.
 * Performans için her çalıştırmada sadece en eski kontrol edilen LIMIT kadar
 * kaydı test eder (round-robin), kalanları olduğu gibi bırakır.
 * Kırık bulunanları Google arama linkine çevirir ve `linkKontrol` zaman damgası ekler.
 * @param {Array} mevcutData
 * @param {number} limit
 */
async function kirikLinkleriDuzelt(mevcutData, limit = 15) {
  // Google arama linki olanları (zaten fallback) tekrar test etmeye gerek yok
  const adaylar = mevcutData
    .filter(p => p.url && !p.url.includes('google.com/search'))
    .sort((a, b) => (a.linkKontrol || '').localeCompare(b.linkKontrol || ''))
    .slice(0, limit);

  if (adaylar.length === 0) return { kontrolEdilen: 0, duzeltilen: 0 };

  console.log(`🔗 ${adaylar.length} kaydın linki kontrol ediliyor...`);
  let duzeltilen = 0;

  for (const p of adaylar) {
    const calisiyor = await linkCalisiyorMu(p.url);
    if (!calisiyor) {
      const eskiUrl = p.url;
      p.url = googleAramaLinki(p.baslik, p.kaynak);
      console.log(`   ⚠️  Kırık link düzeltildi: "${p.baslik}"`);
      console.log(`      Eski: ${eskiUrl}`);
      console.log(`      Yeni: ${p.url} (Google araması)`);
      duzeltilen++;
    }
    p.linkKontrol = new Date().toISOString();
    await new Promise(r => setTimeout(r, 300)); // siteleri yormamak için kısa bekleme
  }

  console.log(`🔗 Link kontrolü tamamlandı: ${adaylar.length} kontrol edildi, ${duzeltilen} düzeltildi.\n`);
  return { kontrolEdilen: adaylar.length, duzeltilen };
}

// ─── Google News RSS kaynakları ───────────────────────────────────────────────
const KAYNAKLAR = [
  { ad: 'KOSGEB (News)',         url: 'https://news.google.com/rss/search?q=KOSGEB+hibe+destek+program+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TÜBİTAK (News)',        url: 'https://news.google.com/rss/search?q=TÜBİTAK+TEYDEB+ar-ge+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Yatırım Teşvik (News)', url: 'https://news.google.com/rss/search?q=yatırım+teşvik+hibe+başvuru+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Kalkınma Ajansı (News)',url: 'https://news.google.com/rss/search?q=kalkınma+ajansı+mali+destek+hibe+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'İhracat Desteği (News)',url: 'https://news.google.com/rss/search?q=ihracat+desteği+TURQUALITY+hibe+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TKDK IPARD (News)',     url: 'https://news.google.com/rss/search?q=TKDK+IPARD+tarım+hibe+çağrı+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TRAKYAKA (News)',       url: 'https://news.google.com/rss/search?q=TRAKYAKA+destek+program+Tekirdağ+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Tekirdağ Hibe (News)',  url: 'https://news.google.com/rss/search?q=Tekirdağ+Çorlu+hibe+teşvik+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Resmi Gazete (News)',   url: 'https://news.google.com/rss/search?q=Resmi+Gazete+hibe+teşvik+destek+programı+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'KOSGEB RSS',            url: 'https://www.kosgeb.gov.tr/site/tr/genel/duyuru/rss' },
  { ad: 'TÜBİTAK RSS',          url: 'https://www.tubitak.gov.tr/tr/duyurular/rss' },
  { ad: 'Resmi Gazete RSS',      url: 'https://www.resmigazete.gov.tr/rss/resmigazete.xml' },
  { ad: 'Ticaret Bak. RSS',      url: 'https://ticaret.gov.tr/duyurular/rss.xml' },
  { ad: 'Sanayi Bak. RSS',       url: 'https://www.sanayi.gov.tr/rss/haberler' },
  { ad: 'Tarım Bak. RSS',        url: 'https://www.tarimorman.gov.tr/rss/duyurular' },
  { ad: 'TKDK Duyuru RSS',       url: 'https://www.tkdk.gov.tr/rss' },
];

const DIREKT_KAYNAKLAR = [
  {
    ad: 'TRAKYAKA Açık Programlar',
    url: 'https://www.trakyaka.org.tr/tr/33555/Acik-Olan-Destek-Programlari',
    snapshot_key: 'trakyaka_acik_programlar'
  },
];

// ─── URL indir ────────────────────────────────────────────────────────────────
function fetchUrl(url, ms = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CorlutsoBot/2.0)', 'Accept': '*/*' },
      timeout: ms
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, ms).then(resolve).catch(reject);
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── TRAKYAKA gibi doğrudan sayfaları kontrol et ─────────────────────────────
async function direktSayfaKontrol(kaynaklar) {
  const SNAPSHOT_PATH = path.join(__dirname, 'snapshot_direkt.json');
  let snapshots = {};
  try { snapshots = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')); } catch(e) {}

  const degisiklikler = [];

  for (const k of kaynaklar) {
    try {
      const { status, body } = await fetchUrl(k.url);
      if (status !== 200) continue;

      const metin = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .substring(0, 2000);

      const eski = snapshots[k.snapshot_key] || '';
      if (eski && metin !== eski) {
        console.log(`  🔔 ${k.ad} sayfasında değişiklik tespit edildi!`);
        degisiklikler.push({ ad: k.ad, url: k.url });
      } else if (!eski) {
        console.log(`  📸 ${k.ad} ilk snapshot alındı.`);
      }
      snapshots[k.snapshot_key] = metin;
    } catch(e) {
      console.log(`  ⚠️  ${k.ad} kontrol edilemedi: ${e.message}`);
    }
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshots, null, 2));
  return degisiklikler;
}

// ─── RSS / XML'den başlıkları çıkar ─────────────────────────────────────────
function rssBasliklari(xml, max = 12) {
  const items = [];

  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null && items.length < max) {
    const t = (m[1].match(/<title[^>]*><!\[CDATA\[(.*?)\]\]>/) ||
               m[1].match(/<title[^>]*>(.*?)<\/title>/))?.[1] || '';
    const d = (m[1].match(/<updated>(.*?)<\/updated>/) ||
               m[1].match(/<published>(.*?)<\/published>/))?.[1]?.substring(0, 10) || '';
    if (t.trim()) items.push(`${t.trim()} [${d}]`);
  }

  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  while ((m = itemRe.exec(xml)) !== null && items.length < max) {
    const t = (m[1].match(/<title><!\[CDATA\[(.*?)\]\]>/) ||
               m[1].match(/<title>(.*?)<\/title>/))?.[1] || '';
    const d = (m[1].match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.substring(0, 16) || '';
    const link = (m[1].match(/<link>(.*?)<\/link>/) ||
                  m[1].match(/<link[^>]+href="([^"]+)"/))?.[1] || '';
    if (t.trim()) items.push(`${t.trim()} [${d}]${link ? ' URL:'+link : ''}`);
  }

  if (items.length === 0 && xml.includes('resmigazete')) {
    const satirlar = xml.split(/[\r\n]+/).filter(s =>
      s.includes('hibe') || s.includes('teşvik') || s.includes('destek') ||
      s.includes('program') || s.includes('yönetmelik') || s.includes('tebliğ')
    ).slice(0, max);
    satirlar.forEach(s => items.push(s.trim().substring(0, 120)));
  }

  return items.filter(Boolean);
}

// ─── TEK Gemini çağrısı ───────────────────────────────────────────────────────
async function geminiAnaliz(tumHaberler, mevcutData) {
  const bugun = new Date().toLocaleDateString('tr-TR');
  const mevcutBasliklar = mevcutData.map(d => `- ${d.baslik}`).join('\n');

  const prompt = `Bugün: ${bugun}

Aşağıda Türkiye'deki hibe/teşvik haberleri var. Bunlardan GERÇEKTEN YENİ olan programları tespit et.

KURALLAR:
1. Başvuru tarihi geçmemiş olmalı
2. Aşağıdaki MEVCUT LİSTEDE OLMAMALI
3. Kesin bilgi yoksa EKLEME
4. Bulamazsan sadece [] döndür

URL KURALI (EN ÖNEMLİ):
- url alanına KESİNLİKLE ana sayfa verme (örn: https://www.kosgeb.gov.tr gibi)
- Haberdeki spesifik program sayfasının tam URL'sini yaz
- Eğer haberde direkt link yoksa kurumun ilgili program alt sayfasını tahmin et:
  * KOSGEB programları: https://www.kosgeb.gov.tr/site/tr/genel/destekdetay/[ID]/[slug]
  * TÜBİTAK programları: https://tubitak.gov.tr/tr/destekler/sanayi/ulusal-destek-programlari/[PROGRAM-NO]
  * Ticaret Bakanlığı: https://ticaret.gov.tr/destekler/ihracat-destekleri
  * TKDK/IPARD: https://www.tkdk.gov.tr/ProjeIslemleri/CagriIlanArsiv
  * Tarım Bakanlığı: https://www.tarimorman.gov.tr/Konu/[ilgili-konu]
  * KGF: https://www.kgf.com.tr/urunler/[urun-adi]
  * Eximbank: https://www.eximbank.gov.tr/tr/urunler/krediler/[kredi-turu]
  * Kalkınma Ajansları: https://www.yatirimadestek.gov.tr
- Son çare olarak boş bırak, kod otomatik Google aramasına yönlendirecek

MEVCUT LİSTE (bunları tekrar ekleme):
${mevcutBasliklar}

HABERLER:
${tumHaberler}

Sadece JSON dizi döndür, başka hiçbir şey yazma, markdown kullanma:
[{"baslik":"...","tur":"Hibe","kaynak":"...","grup":"Hibe Programları","sektor":["Tüm Sektörler"],"tutar":"...","durum":"açık","son":"YYYY-MM-DD","aciklama":"...","url":"https://spesifik-program-sayfasi.gov.tr/..."}]

Geçerli tur değerleri: Hibe, Yatırım Teşviki, İstihdam Teşviki, Finansman Garantisi, Uygun Faizli Kredi, Teknik Destek, Vergi/SGK Teşviki
Geçerli grup değerleri: Hibe Programları, Yatırım Teşvikleri, İhracat ve Uluslararasılaşma, Kredi Garantisi (KGF), Uygun Faizli Krediler, AB ve Uluslararası Hibeler, Bölgesel Kalkınma (Ajanslar), Vergi ve SGK Avantajları, İstihdam ve Personel Destekleri, Tarım Destekleri, Enerji ve Yeşil Dönüşüm, Turizm Destekleri`;

  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2000 }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 45000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200)
            return reject(new Error(`HTTP ${res.statusCode} — ${parsed?.error?.message || ''}`));
          const text = parsed?.candidates?.[0]?.content?.parts?.map(p => p.text||'').join('').trim() || '[]';
          const temiz = text.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
          resolve(JSON.parse(temiz));
        } catch(e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(bodyStr); req.end();
  });
}

// ─── E-posta ──────────────────────────────────────────────────────────────────
async function epostaGonder(yeni) {
  if (!RESEND_KEY || !BILDIRIM_EMAIL || yeni.length === 0) return;
  const html = `<div style="font-family:sans-serif;max-width:680px">
    <div style="background:#1a3a5c;padding:18px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">🆕 ${yeni.length} yeni program eklendi</h2>
      <p style="color:#93b8d8;margin:4px 0 0">${new Date().toLocaleDateString('tr-TR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
    <div style="background:#fff;padding:18px;border:1px solid #eee;border-top:none">
      ${yeni.map(p=>`<div style="padding:10px 0;border-bottom:1px solid #f0f0f0">
        <strong>${p.baslik}</strong><br>
        <span style="font-size:13px;color:#555">${p.kaynak} · Son: ${p.son}</span>
        <a href="${p.url}" style="float:right;font-size:13px;color:#1a3a5c">Kaynak →</a>
      </div>`).join('')}
    </div>
    <p style="text-align:center;font-size:12px;color:#999;margin-top:12px">Çorlu TSO Hibe Motoru · hibeler.corlutso.org.tr</p>
  </div>`;
  const payload = JSON.stringify({ from:'Hibe Motor Bot <bot@corlutso.org.tr>', to:[BILDIRIM_EMAIL], subject:`🆕 ${yeni.length} yeni hibe programı`, html });
  await new Promise((res,rej)=>{
    const r = https.request({ hostname:'api.resend.com', path:'/emails', method:'POST',
      headers:{'Authorization':`Bearer ${RESEND_KEY}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}
    }, re=>{ let b=''; re.on('data',c=>b+=c); re.on('end',()=>re.statusCode<300?res():rej(new Error(`Resend ${re.statusCode}`))); });
    r.on('error',rej); r.write(payload); r.end();
  });
  console.log(`✉️  Bildirim → ${BILDIRIM_EMAIL}`);
}

// ─── ANA FONKSİYON ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 Hibe Motor Başladı — ${new Date().toLocaleString('tr-TR')}`);
  console.log(`   Strateji: ${KAYNAKLAR.length} RSS → 1 Gemini isteği\n`);

  let mevcutData = [];
  try { mevcutData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]'); }
  catch(e) { console.warn('⚠️  data.json okunamadı.'); }

  const bugun = new Date(); bugun.setHours(0,0,0,0);
  const onceki = mevcutData.length;
  mevcutData = mevcutData
    .filter(p => p.son === 'Süresiz' || Math.ceil((new Date(p.son)-bugun)/86400000) >= -15)
    .map(p => {
      if (p.son === 'Süresiz') return { ...p, durum:'açık' };
      const g = Math.ceil((new Date(p.son)-bugun)/86400000);
      return { ...p, durum: g>14?'açık':g>0?'kapanmak üzere':'kapandı' };
    });
  if (onceki > mevcutData.length)
    console.log(`🗑️  ${onceki-mevcutData.length} eski program temizlendi.\n`);

  console.log('🔗 Mevcut kayıtların linkleri kontrol ediliyor (kırık linkler düzeltiliyor)...');
  try {
    const { kontrolEdilen, duzeltilen } = await kirikLinkleriDuzelt(mevcutData, 15);
    rapor.linkKontrol = { kontrolEdilen, duzeltilen };
    if (kontrolEdilen > 0) {
      fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutData, null, 2), 'utf8');
    }
  } catch(e) {
    console.warn('⚠️  Link kontrolü hatası:', e.message);
  }

  console.log('🔍 Bölgesel kaynaklar doğrudan kontrol ediliyor...');
  const tumBasliklar = [];
  const direktDegisiklikler = await direktSayfaKontrol(DIREKT_KAYNAKLAR);
  if (direktDegisiklikler.length > 0) {
    console.log(`  ⚠️  ${direktDegisiklikler.length} sayfada değişiklik var!`);
    direktDegisiklikler.forEach(d => {
      tumBasliklar.push(`[${d.ad}] Sayfa güncellendi, yeni program olabilir. Kontrol et: ${d.url}`);
    });
  }

  console.log('📡 RSS kaynakları taranıyor...');
  const rapor = { tarih: new Date().toISOString(), kaynaklar: [] };

  for (const k of KAYNAKLAR) {
    process.stdout.write(`   ${k.ad}... `);
    try {
      const { status, body } = await fetchUrl(k.url);
      if (status === 200) {
        const basliklar = rssBasliklari(body, 8);
        basliklar.forEach(b => tumBasliklar.push(`[${k.ad}] ${b}`));
        console.log(`${basliklar.length} haber`);
        rapor.kaynaklar.push({ kaynak: k.ad, durum: 'OK', bulunan: basliklar.length });
      } else {
        console.log(`HTTP ${status}`);
        rapor.kaynaklar.push({ kaynak: k.ad, durum: `HTTP ${status}` });
      }
    } catch(e) {
      console.log(`Hata: ${e.message}`);
      rapor.kaynaklar.push({ kaynak: k.ad, durum: `Hata: ${e.message}` });
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n   Toplam ${tumBasliklar.length} haber toplandı.\n`);

  if (tumBasliklar.length === 0) {
    console.log('⚠️  Hiç haber toplanamadı, çıkılıyor.');
    fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2));
    return;
  }

  console.log('🤖 Gemini analiz ediyor... (1 istek)');
  let yeniProgramlar = [];
  try {
    const bulunanlar = await geminiAnaliz(tumBasliklar.join('\n'), mevcutData);

    if (!Array.isArray(bulunanlar) || bulunanlar.length === 0) {
      console.log('   Yeni program tespit edilmedi.');
    } else {
      const mevcutBasliklar = mevcutData.map(d => d.baslik.toLowerCase());
      yeniProgramlar = bulunanlar.filter(p => {
        if (!p.baslik || !p.son) return false;
        return !mevcutBasliklar.some(mb =>
          mb.includes(p.baslik.toLowerCase().substring(0,20)) ||
          p.baslik.toLowerCase().includes(mb.substring(0,20))
        );
      });

      if (yeniProgramlar.length === 0) {
        console.log('   Tespit edilenler zaten listede var.');
      } else {
        let nextId = mevcutData.length > 0 ? Math.max(...mevcutData.map(d=>d.id||0))+1 : 1;
        yeniProgramlar.forEach(p => {
          p.id = nextId++;
          // urlDogru ile ana sayfa URL'lerini temizle
          p.url = urlDogru(p.url, p.baslik, p.kaynak);
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

  fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutData, null, 2), 'utf8');
  rapor.yeniEklenen = yeniProgramlar.length;
  rapor.toplamProgram = mevcutData.length;
  fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2), 'utf8');

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 SONUÇ: ${mevcutData.length} program, ${yeniProgramlar.length} yeni eklendi`);
  console.log(`   Açık: ${mevcutData.filter(p=>p.durum==='açık').length} | Kapanmak üzere: ${mevcutData.filter(p=>p.durum==='kapanmak üzere').length} | Kapandı: ${mevcutData.filter(p=>p.durum==='kapandı').length}`);
  if (rapor.linkKontrol) {
    console.log(`   🔗 Link kontrolü: ${rapor.linkKontrol.kontrolEdilen} kontrol edildi, ${rapor.linkKontrol.duzeltilen} düzeltildi`);
  }
  console.log(`${'─'.repeat(50)}\n`);

  if (yeniProgramlar.length > 0) {
    try { await epostaGonder(yeniProgramlar); } catch(e) { console.warn('⚠️  E-posta gönderilemedi:', e.message); }
  }
}

main().catch(err => { console.error('❌ Kritik hata:', err); process.exit(1); });
