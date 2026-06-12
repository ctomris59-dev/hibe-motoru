/**
 * scraper.js — Çorlu TSO Hibe Motoru
 * 
 * Google News RSS'leri tarar → ham metni Gemini'ye verir
 * → Gemini yeni programları JSON olarak döner → data.json'a ekler.
 * 
 * Gerekli GitHub Secrets:
 *   GEMINI_API_KEY   → Google AI Studio (ücretsiz)
 *   BILDIRIM_EMAIL   → (opsiyonel)
 *   RESEND_API_KEY   → (opsiyonel)
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('❌ GEMINI_API_KEY bulunamadı!'); process.exit(1); }

const DATA_PATH      = path.join(__dirname, '../data.json');
const RAPOR_PATH     = path.join(__dirname, 'rapor.json');
const BILDIRIM_EMAIL = process.env.BILDIRIM_EMAIL || '';
const RESEND_KEY     = process.env.RESEND_API_KEY  || '';

// ─── Google News RSS kaynakları ───────────────────────────────────────────────
// GitHub Actions'tan erişilebilir, engel yok, gerçek zamanlı haber akışı
const KAYNAKLAR = [
  { ad: 'KOSGEB hibe 2026',          url: 'https://news.google.com/rss/search?q=KOSGEB+hibe+destek+program+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TÜBİTAK destek 2026',       url: 'https://news.google.com/rss/search?q=TÜBİTAK+TEYDEB+destek+program+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Yatırım teşvik 2026',       url: 'https://news.google.com/rss/search?q=yatırım+teşvik+hibe+başvuru+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'Kalkınma ajansı hibe 2026', url: 'https://news.google.com/rss/search?q=kalkınma+ajansı+hibe+destek+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'İhracat desteği 2026',      url: 'https://news.google.com/rss/search?q=ihracat+desteği+TURQUALITY+2026&hl=tr&gl=TR&ceid=TR:tr' },
  { ad: 'TKDK IPARD 2026',           url: 'https://news.google.com/rss/search?q=TKDK+IPARD+hibe+çağrı+2026&hl=tr&gl=TR&ceid=TR:tr' },
];

// ─── Yardımcı: URL'yi indir ───────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CorlutsoHibeBot/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9'
      },
      timeout: timeoutMs
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımı')); });
  });
}

// ─── RSS'ten başlık + açıklama metni çıkar ───────────────────────────────────
function rssMetniCikar(xml, maxItem = 15) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItem) {
    const block = match[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   block.match(/<title>(.*?)<\/title>/))?.[1] || '';
    const desc  = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                   block.match(/<description>(.*?)<\/description>/))?.[1] || '';
    const link  = (block.match(/<link>(.*?)<\/link>/))?.[1] || '';
    const date  = (block.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
    if (title) items.push(`- ${title.trim()} [${date.substring(0,16)}] ${desc.substring(0,120).replace(/<[^>]+>/g,'')}`);
  }
  return items.join('\n');
}

// ─── Gemini'ye metin analiz ettir (grounding'siz, ücretsiz) ──────────────────
async function geminiAnaliz(kaynak, haberMetni, mevcutData) {
  const bugun = new Date().toLocaleDateString('tr-TR');
  const mevcutBasliklar = mevcutData.map(d => d.baslik).join('\n');

  const prompt = `Bugün: ${bugun}

Aşağıda "${kaynak}" konusunda son haberler var. Bu haberleri inceleyerek:
- Gerçekten YENİ bir hibe, teşvik veya destek programı duyurusu var mı?
- Başvuru tarihi henüz geçmemiş mi?
- Aşağıdaki mevcut listemizde YOK mu?

MEVCUT LİSTE (bunları tekrar ekleme):
${mevcutBasliklar}

HABERLER:
${haberMetni}

Eğer yeni program yoksa sadece [] döndür.
Varsa şu formatta JSON dizi döndür (başka hiçbir şey yazma, markdown kullanma):
[
  {
    "baslik": "Program adı – dönem/yıl bilgisiyle",
    "tur": "Hibe veya Yatırım Teşviki veya İstihdam Teşviki veya Finansman Garantisi veya Uygun Faizli Kredi veya Teknik Destek veya Vergi/SGK Teşviki",
    "kaynak": "Resmi kurum adı",
    "grup": "Hibe Programları veya Yatırım Teşvikleri veya İhracat ve Uluslararasılaşma veya Kredi Garantisi (KGF) veya Uygun Faizli Krediler veya AB ve Uluslararası Hibeler veya Bölgesel Kalkınma (Ajanslar) veya Vergi ve SGK Avantajları veya İstihdam ve Personel Destekleri veya Tarım Destekleri veya Enerji ve Yeşil Dönüşüm veya Turizm Destekleri",
    "sektor": ["Tüm Sektörler"],
    "tutar": "Destek miktarı veya oranı",
    "durum": "açık",
    "son": "YYYY-MM-DD veya Süresiz",
    "aciklama": "1-2 cümle açıklama",
    "url": "https://resmi-kaynak-url"
  }
]`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1500 }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} — ${parsed?.error?.message || data.substring(0,200)}`));
            return;
          }
          const text = parsed?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '[]';
          const temiz = text.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
          resolve(JSON.parse(temiz));
        } catch(e) { reject(new Error(`JSON parse hatası: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini zaman aşımı')); });
    req.write(body);
    req.end();
  });
}

// ─── Resend e-posta ───────────────────────────────────────────────────────────
async function epostaGonder(yeniProgramlar) {
  if (!RESEND_KEY || !BILDIRIM_EMAIL) return;
  const satirlar = yeniProgramlar.map(p =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.baslik}</strong></td>
     <td style="padding:8px;border-bottom:1px solid #eee;color:#1e6e3a">${p.durum}</td>
     <td style="padding:8px;border-bottom:1px solid #eee;color:#666">${p.son}</td>
     <td style="padding:8px;border-bottom:1px solid #eee"><a href="${p.url}" style="color:#1a3a5c">→</a></td></tr>`
  ).join('');
  const html = `<div style="font-family:sans-serif;max-width:700px">
    <div style="background:#1a3a5c;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">🆕 ${yeniProgramlar.length} yeni program eklendi</h2>
      <p style="color:#93b8d8;margin:4px 0 0">${new Date().toLocaleDateString('tr-TR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
    <div style="background:#fff;padding:20px;border:1px solid #eee;border-top:none">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f5f5f3">
          <th style="padding:10px;text-align:left;font-size:13px">Program</th>
          <th style="padding:10px;text-align:left;font-size:13px">Durum</th>
          <th style="padding:10px;text-align:left;font-size:13px">Son tarih</th>
          <th style="padding:10px;text-align:left;font-size:13px">Link</th>
        </tr></thead><tbody>${satirlar}</tbody>
      </table>
    </div>
    <p style="text-align:center;font-size:12px;color:#999">Çorlu TSO Hibe Motoru · hibeler.corlutso.org.tr</p>
  </div>`;

  const payload = JSON.stringify({
    from: 'Hibe Motor Bot <bot@corlutso.org.tr>',
    to: [BILDIRIM_EMAIL],
    subject: `🆕 ${yeniProgramlar.length} yeni program — Hibe Motoru`,
    html
  });
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`Resend ${res.statusCode}: ${b}`)));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
  console.log(`✉️  Bildirim gönderildi → ${BILDIRIM_EMAIL}`);
}

// ─── Ana fonksiyon ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 Hibe Motor Tarama Başladı — ${new Date().toLocaleString('tr-TR')}\n`);

  let mevcutData = [];
  try { mevcutData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]'); }
  catch (e) { console.warn('⚠️  data.json okunamadı.'); }

  // Tarihleri temizle
  const bugun = new Date(); bugun.setHours(0,0,0,0);
  const onceki = mevcutData.length;
  mevcutData = mevcutData.filter(p => {
    if (p.son === 'Süresiz') return true;
    return Math.ceil((new Date(p.son) - bugun) / 86400000) >= -15;
  }).map(p => {
    if (p.son === 'Süresiz') return { ...p, durum: 'açık' };
    const gun = Math.ceil((new Date(p.son) - bugun) / 86400000);
    return { ...p, durum: gun > 14 ? 'açık' : gun > 0 ? 'kapanmak üzere' : 'kapandı' };
  });
  if (onceki > mevcutData.length) console.log(`🗑️  ${onceki - mevcutData.length} eski program temizlendi.\n`);

  let nextId = mevcutData.length > 0 ? Math.max(...mevcutData.map(d => d.id || 0)) + 1 : 1;
  const tumYeni = [];
  const rapor = { tarih: new Date().toISOString(), kaynaklar: [] };

  for (const kaynak of KAYNAKLAR) {
    process.stdout.write(`  📡 ${kaynak.ad} RSS taranıyor...`);
    let haberMetni = '';

    // 1. RSS'i çek
    try {
      const { status, body } = await fetchUrl(kaynak.url);
      if (status === 200) {
        haberMetni = rssMetniCikar(body);
        console.log(` ${haberMetni.split('\n').length} haber bulundu.`);
      } else {
        console.log(` HTTP ${status}, atlandı.`);
        rapor.kaynaklar.push({ kaynak: kaynak.ad, durum: `HTTP ${status}` });
        await bekle(5000); continue;
      }
    } catch (e) {
      console.log(` Bağlantı hatası: ${e.message}`);
      rapor.kaynaklar.push({ kaynak: kaynak.ad, durum: `Hata: ${e.message}` });
      await bekle(5000); continue;
    }

    if (!haberMetni.trim()) {
      console.log(`  ℹ️  İçerik boş, atlandı.`);
      rapor.kaynaklar.push({ kaynak: kaynak.ad, durum: 'Boş içerik' });
      await bekle(5000); continue;
    }

    // 2. Gemini'ye analiz ettir
    process.stdout.write(`  🤖 Gemini analiz ediyor...`);
    try {
      const bulunanlar = await geminiAnaliz(kaynak.ad, haberMetni, mevcutData);

      if (!Array.isArray(bulunanlar) || bulunanlar.length === 0) {
        console.log(' Yeni program yok.');
        rapor.kaynaklar.push({ kaynak: kaynak.ad, durum: 'Yeni program yok', bulunan: 0 });
      } else {
        // Tekrar ekleme kontrolü
        const mevcutBasliklar = [...mevcutData, ...tumYeni].map(d => d.baslik.toLowerCase());
        const gercekYeniler = bulunanlar.filter(p => {
          if (!p.baslik || !p.son) return false;
          return !mevcutBasliklar.some(mb =>
            mb.includes(p.baslik.toLowerCase().substring(0, 20)) ||
            p.baslik.toLowerCase().includes(mb.substring(0, 20))
          );
        });

        if (gercekYeniler.length === 0) {
          console.log(' Yeni program yok (tekrar).');
          rapor.kaynaklar.push({ kaynak: kaynak.ad, durum: 'Tekrar', bulunan: 0 });
        } else {
          gercekYeniler.forEach(p => { p.id = nextId++; p.durum = p.durum || 'açık'; tumYeni.push(p); mevcutData.push(p); });
          console.log(` ✅ ${gercekYeniler.length} yeni program!`);
          gercekYeniler.forEach(p => console.log(`     + ${p.baslik} (son: ${p.son})`));
          rapor.kaynaklar.push({ kaynak: kaynak.ad, bulunan: gercekYeniler.length, programlar: gercekYeniler.map(p => p.baslik) });
        }
      }
    } catch (e) {
      console.log(` ❌ Gemini hatası: ${e.message}`);
      rapor.kaynaklar.push({ kaynak: kaynak.ad, durum: `Gemini hatası: ${e.message}` });
    }

    // Sorgular arası bekleme (rate limit önlemi)
    await bekle(12000);
  }

  // Kaydet
  fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutData, null, 2), 'utf8');
  fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2), 'utf8');

  console.log('\n' + '─'.repeat(50));
  console.log(`📊 SONUÇ: ${mevcutData.length} program (${mevcutData.filter(p=>p.durum==='açık').length} açık, ${tumYeni.length} yeni eklendi)`);
  console.log('─'.repeat(50) + '\n');

  if (tumYeni.length > 0) {
    try { await epostaGonder(tumYeni); } catch (e) { console.warn('⚠️  E-posta gönderilemedi:', e.message); }
  }
}

function bekle(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('❌ Kritik hata:', err); process.exit(1); });
