/**
 * scraper.js — Çorlu TSO Hibe Motoru
 * 
 * Tüm RSS kaynaklarını toplar → TEK bir Gemini isteğiyle analiz eder.
 * Günlük kota kullanımı: 1 istek (önceki versiyonda 6 istek)
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

// ─── Google News RSS kaynakları ───────────────────────────────────────────────
const KAYNAKLAR = [
  { ad: 'KOSGEB',             url: 'https://news.google.com/rss/search?q=KOSGEB+hibe+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TÜBİTAK',           url: 'https://news.google.com/rss/search?q=TÜBİTAK+TEYDEB+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Yatırım Teşvik',    url: 'https://news.google.com/rss/search?q=yatırım+teşvik+hibe+başvuru+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Kalkınma Ajansı',   url: 'https://news.google.com/rss/search?q=kalkınma+ajansı+hibe+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'İhracat Desteği',   url: 'https://news.google.com/rss/search?q=ihracat+desteği+hibe+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TKDK IPARD',        url: 'https://news.google.com/rss/search?q=TKDK+IPARD+hibe+2026&hl=tr&gl=TR&ceid=TR:tr' },
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

// ─── RSS'ten başlıkları çıkar ────────────────────────────────────────────────
function rssBasliklari(xml, max = 10) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < max) {
    const t = (m[1].match(/<title><!\[CDATA\[(.*?)\]\]>/) || m[1].match(/<title>(.*?)<\/title>/))?.[1] || '';
    const d = (m[1].match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.substring(0, 16) || '';
    if (t.trim()) items.push(`${t.trim()} [${d}]`);
  }
  return items;
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
  * TKDK/IPARD: https://www.tkdk.gov.tr/Sayfa/IlanveBasvuru
  * Tarım Bakanlığı: https://www.tarimorman.gov.tr/Konu/[ilgili-konu]
  * KGF: https://www.kgf.com.tr/urunler/[urun-adi]
  * Eximbank: https://www.eximbank.gov.tr/tr/urunler/krediler/[kredi-turu]
  * Kalkınma Ajansları: https://www.yatirimadestek.gov.tr
- Son çare olarak https://www.google.com/search?q=[program+adı+başvuru+2026] kullan

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

  // Mevcut veriyi yükle
  let mevcutData = [];
  try { mevcutData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]'); }
  catch(e) { console.warn('⚠️  data.json okunamadı.'); }

  // Tarihleri güncelle / temizle
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

  // ── AŞAMA 1: Tüm RSS'leri topla ─────────────────────────────────────────────
  console.log('📡 RSS kaynakları taranıyor...');
  const tumBasliklar = [];
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
    await new Promise(r => setTimeout(r, 1000)); // RSS'ler arası kısa bekleme
  }

  console.log(`\n   Toplam ${tumBasliklar.length} haber toplandı.\n`);

  if (tumBasliklar.length === 0) {
    console.log('⚠️  Hiç haber toplanamadı, çıkılıyor.');
    fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2));
    return;
  }

  // ── AŞAMA 2: TEK Gemini isteği ───────────────────────────────────────────────
  console.log('🤖 Gemini analiz ediyor... (1 istek)');
  let yeniProgramlar = [];
  try {
    const bulunanlar = await geminiAnaliz(tumBasliklar.join('\n'), mevcutData);

    if (!Array.isArray(bulunanlar) || bulunanlar.length === 0) {
      console.log('   Yeni program tespit edilmedi.');
    } else {
      // Tekrar kontrolü
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
        yeniProgramlar.forEach(p => { p.id = nextId++; p.url = urlDogru(p.url, p.baslik, p.kaynak); mevcutData.push(p); });
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
  console.log(`   Açık: ${mevcutData.filter(p=>p.durum==='açık').length} | Kapanmak üzere: ${mevcutData.filter(p=>p.durum==='kapanmak üzere').length} | Kapandı: ${mevcutData.filter(p=>p.durum==='kapandı').length}`);
  console.log(`${'─'.repeat(50)}\n`);

  if (yeniProgramlar.length > 0) {
    try { await epostaGonder(yeniProgramlar); } catch(e) { console.warn('⚠️  E-posta gönderilemedi:', e.message); }
  }
}

main().catch(err => { console.error('❌ Kritik hata:', err); process.exit(1); });
