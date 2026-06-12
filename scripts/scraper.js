/**
 * scraper.js — Çorlu TSO Hibe Motoru
 * 
 * Her gün GitHub Actions tarafından çalıştırılır.
 * Gemini'nin Google Search grounding özelliğiyle Türkiye'deki
 * güncel hibe/teşvik duyurularını tarar, yenileri varsa data.json'a ekler.
 * 
 * Gerekli GitHub Secrets:
 *   GEMINI_API_KEY   → Google AI Studio'dan alınan API anahtarı
 *   BILDIRIM_EMAIL   → (opsiyonel) e-posta bildirimi için
 *   RESEND_API_KEY   → (opsiyonel) Resend.com API anahtarı
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ─── Ortam değişkenleri ───────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ HATA: GEMINI_API_KEY bulunamadı!');
  process.exit(1);
}

const DATA_PATH    = path.join(__dirname, '../data.json');
const RAPOR_PATH   = path.join(__dirname, 'rapor.json');
const BILDIRIM_EMAIL = process.env.BILDIRIM_EMAIL || '';
const RESEND_KEY     = process.env.RESEND_API_KEY  || '';

// ─── Tarama sorguları ─────────────────────────────────────────────────────────
// Her sorgu Gemini'nin Google Search ile arayacağı konuyu temsil eder.
const SORGULAR = [
  'KOSGEB 2026 yeni hibe programı başvuru açıldı son tarih',
  'TÜBİTAK TEYDEB 2026 sanayi ar-ge destek çağrı açıldı',
  'Ticaret Bakanlığı ihracat desteği 2026 yeni program başvuru',
  'Sanayi Teknoloji Bakanlığı yatırım teşvik 2026 yeni çağrı',
  'kalkınma ajansı hibe 2026 başvuru açıldı TRAKYAKA İSTKA',
  'TKDK IPARD 2026 hibe çağrı başvuru',
  'KGF kredi garanti fonu 2026 yeni program',
  'Türk Eximbank 2026 yeni destek programı',
  'KOSGEB Girişimci Destek Programı 2026 yeni dönem başvuru',
  'Tarım Bakanlığı kırsal kalkınma hibe 2026 başvuru açıldı'
];

// ─── Yardımcı: HTTPS POST isteği ─────────────────────────────────────────────
function httpsPost(hostname, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      },
      timeout: 60000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımı')); });
    req.write(body);
    req.end();
  });
}

// ─── Gemini'yi Google Search grounding ile çağır ──────────────────────────────
async function geminiAra(sorgu, mevcutData) {
  const mevcutBasliklar = mevcutData.map(d => d.baslik).join('\n');
  const bugun = new Date().toLocaleDateString('tr-TR');

  const prompt = `
Bugünün tarihi: ${bugun}

Görevin: "${sorgu}" konusunda Türkiye'deki güncel hibe, teşvik ve destek programı duyurularını bul.

Mevcut veritabanımızdaki programlar (BUNLARI TEKRAR EKLEME):
${mevcutBasliklar}

Kurallar:
1. Sadece YENİ ve gerçekten AÇIK programları bul (başvuru tarihi henüz geçmemiş).
2. Tarih bilgisi net olmayan programları EKLEME.
3. Bulamazsan BOŞ dizi döndür: []
4. Her program için şu alanları doldur:
   - baslik: Programın tam adı (dönem bilgisi dahil, örn: "KOSGEB 1507 2026/2 Çağrısı")
   - tur: Şunlardan biri → "Hibe" | "Yatırım Teşviki" | "İstihdam Teşviki" | "Finansman Garantisi" | "Uygun Faizli Kredi" | "Sigorta / Güvence" | "Teknik Destek" | "Vergi/SGK Teşviki"
   - kaynak: Kurumun resmi adı
   - grup: Şunlardan biri → "Hibe Programları" | "Yatırım Teşvikleri" | "İhracat ve Uluslararasılaşma" | "İhracat Finansmanı (Eximbank)" | "Kredi Garantisi (KGF)" | "Uygun Faizli Krediler" | "AB ve Uluslararası Hibeler" | "Bölgesel Kalkınma (Ajanslar)" | "Vergi ve SGK Avantajları" | "İstihdam ve Personel Destekleri" | "Tarım Destekleri" | "Enerji ve Yeşil Dönüşüm" | "Turizm Destekleri" | "Savunma Sektörü"
   - sektor: Geçerli sektör dizisi → ["Tüm Sektörler"] veya ["Üretim","Teknoloji"] gibi
   - tutar: Destek miktarı veya oranı (string)
   - durum: "açık" | "kapanmak üzere" (son 14 gün)
   - son: "YYYY-MM-DD" formatında son başvuru tarihi, süresizse "Süresiz"
   - aciklama: 1-2 cümle açıklama
   - url: Resmi başvuru veya duyuru URL'si

Sadece JSON dizisi döndür, başka hiçbir şey yazma. Markdown kullanma.
Örnek: [{"baslik":"...","tur":"Hibe",...}]
Bulamazsan: []
`;

  const { status, body } = await httpsPost(
    'generativelanguage.googleapis.com',
    `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],  // Google Search grounding
      generationConfig: {
        temperature: 0.1,  // Düşük sıcaklık = tutarlı JSON çıktısı
        maxOutputTokens: 2048
      }
    }
  );

  if (status !== 200) {
    throw new Error(`Gemini API hatası: HTTP ${status} — ${JSON.stringify(body).substring(0, 200)}`);
  }

  // Yanıttan metni çıkar
  const text = body?.candidates?.[0]?.content?.parts
    ?.map(p => p.text || '')
    .join('')
    .trim() || '[]';

  // JSON temizle (Gemini bazen ```json blokları ekler)
  const temiz = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return JSON.parse(temiz);
}

// ─── Resend ile e-posta gönder ────────────────────────────────────────────────
async function epostaGonder(yeniProgramlar) {
  if (!RESEND_KEY || !BILDIRIM_EMAIL) return;

  const satirlar = yeniProgramlar.map(p =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.baslik}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#1e6e3a">${p.durum}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#666">${p.son}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><a href="${p.url}" style="color:#1a3a5c">→ Git</a></td>
    </tr>`
  ).join('');

  const html = `
  <div style="font-family:sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#1a3a5c;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">🆕 Hibe Motoru — Yeni Program Eklendi</h2>
      <p style="color:#93b8d8;margin:6px 0 0">${new Date().toLocaleDateString('tr-TR', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
    <div style="background:#fff;padding:20px;border:1px solid #eee;border-top:none">
      <p style="color:#555">Günlük AI taraması <strong>${yeniProgramlar.length} yeni program</strong> tespit etti ve otomatik olarak eklendi.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead><tr style="background:#f5f5f3">
          <th style="padding:10px;text-align:left;font-size:13px">Program</th>
          <th style="padding:10px;text-align:left;font-size:13px">Durum</th>
          <th style="padding:10px;text-align:left;font-size:13px">Son Tarih</th>
          <th style="padding:10px;text-align:left;font-size:13px">Link</th>
        </tr></thead>
        <tbody>${satirlar}</tbody>
      </table>
    </div>
    <div style="padding:12px;text-align:center;font-size:12px;color:#999">
      Çorlu TSO Hibe Motoru · hibeler.corlutso.org.tr
    </div>
  </div>`;

  const payload = JSON.stringify({
    from: 'Hibe Motor Bot <bot@corlutso.org.tr>',
    to: [BILDIRIM_EMAIL],
    subject: `🆕 ${yeniProgramlar.length} yeni program eklendi — Hibe Motoru`,
    html
  });

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) resolve();
        else reject(new Error(`Resend HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  console.log(`✉️  Bildirim e-postası gönderildi → ${BILDIRIM_EMAIL}`);
}

// ─── Ana fonksiyon ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 Gemini AI Tarama Başladı — ${new Date().toLocaleString('tr-TR')}\n`);

  // Mevcut veriyi yükle
  let mevcutData = [];
  if (fs.existsSync(DATA_PATH)) {
    try { mevcutData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]'); }
    catch (e) { console.warn('⚠️  data.json okunamadı, boş başlanıyor.'); }
  }

  const bugun = new Date();
  bugun.setHours(0, 0, 0, 0);
  const maxId = mevcutData.length > 0 ? Math.max(...mevcutData.map(d => d.id || 0)) : 0;

  // ── 1. Tarihi geçenleri temizle ──────────────────────────────────────────────
  const oncekiSayisi = mevcutData.length;
  mevcutData = mevcutData.filter(p => {
    if (p.son === 'Süresiz') return true;
    const son = new Date(p.son);
    return Math.ceil((son - bugun) / (1000 * 60 * 60 * 24)) >= -15;
  }).map(p => {
    if (p.son === 'Süresiz') return { ...p, durum: 'açık' };
    const kalanGun = Math.ceil((new Date(p.son) - bugun) / (1000 * 60 * 60 * 24));
    const yeniDurum = kalanGun > 14 ? 'açık' : kalanGun > 0 ? 'kapanmak üzere' : 'kapandı';
    return { ...p, durum: yeniDurum };
  });

  const silinenSayisi = oncekiSayisi - mevcutData.length;
  if (silinenSayisi > 0) console.log(`🗑️  ${silinenSayisi} eski program temizlendi.\n`);

  // ── 2. Her sorgu için Gemini'yi çalıştır ─────────────────────────────────────
  const tumYeniProgramlar = [];
  let nextId = maxId + 1;
  const rapor = { tarih: new Date().toISOString(), sorgular: [] };

  for (const sorgu of SORGULAR) {
    process.stdout.write(`  🔍 "${sorgu.substring(0, 50)}..." → `);

    try {
      const bulunanlar = await geminiAra(sorgu, mevcutData);

      if (!Array.isArray(bulunanlar) || bulunanlar.length === 0) {
        console.log('Yeni program yok.');
        rapor.sorgular.push({ sorgu, bulunan: 0 });
        await bekle(2000);
        continue;
      }

      // Tekrar eklemeyi önle: başlık benzerliği kontrolü
      const mevcutBasliklar = [
        ...mevcutData.map(d => d.baslik.toLowerCase()),
        ...tumYeniProgramlar.map(d => d.baslik.toLowerCase())
      ];

      const gercekYeniler = bulunanlar.filter(p => {
        if (!p.baslik || !p.url || !p.son) return false;
        const benzeri = mevcutBasliklar.some(mb =>
          mb.includes(p.baslik.toLowerCase().substring(0, 20)) ||
          p.baslik.toLowerCase().includes(mb.substring(0, 20))
        );
        return !benzeri;
      });

      if (gercekYeniler.length === 0) {
        console.log('Yeni program yok (tekrar).');
        rapor.sorgular.push({ sorgu, bulunan: 0 });
      } else {
        // ID ata ve listeye ekle
        gercekYeniler.forEach(p => {
          p.id = nextId++;
          p.durum = p.durum || 'açık';
          tumYeniProgramlar.push(p);
          mevcutData.push(p);
        });
        console.log(`✅ ${gercekYeniler.length} yeni program bulundu!`);
        gercekYeniler.forEach(p => console.log(`     + ${p.baslik} (son: ${p.son})`));
        rapor.sorgular.push({ sorgu, bulunan: gercekYeniler.length, programlar: gercekYeniler.map(p => p.baslik) });
      }

    } catch (err) {
      console.log(`❌ Hata: ${err.message}`);
      rapor.sorgular.push({ sorgu, hata: err.message });
    }

    // Rate limit için kısa bekleme
    await bekle(3000);
  }

  // ── 3. Güncellenmiş veriyi kaydet ────────────────────────────────────────────
  fs.writeFileSync(DATA_PATH, JSON.stringify(mevcutData, null, 2), 'utf8');
  fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2), 'utf8');

  // ── 4. Özet ──────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`📊 SONUÇ:`);
  console.log(`   Toplam program: ${mevcutData.length}`);
  console.log(`   Açık: ${mevcutData.filter(p => p.durum === 'açık').length}`);
  console.log(`   Kapanmak üzere: ${mevcutData.filter(p => p.durum === 'kapanmak üzere').length}`);
  console.log(`   Kapandı: ${mevcutData.filter(p => p.durum === 'kapandı').length}`);
  console.log(`   Bu çalışmada eklenen: ${tumYeniProgramlar.length}`);
  console.log('─'.repeat(50) + '\n');

  // ── 5. E-posta bildirimi ──────────────────────────────────────────────────────
  if (tumYeniProgramlar.length > 0) {
    try { await epostaGonder(tumYeniProgramlar); }
    catch (e) { console.warn('⚠️  E-posta gönderilemedi:', e.message); }
  }
}

function bekle(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('❌ Kritik hata:', err);
  process.exit(1);
});
