/**
 * scraper.js
 * Her Pazartesi çalışır. İzleme listesindeki kaynak siteleri kontrol eder,
 * önceki hafta ile karşılaştırır, değişiklik varsa e-posta gönderir.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ─── İzleme listesi ──────────────────────────────────────────────────────────
// Her kaynak için: url + kontrol edilecek anahtar kelimeler
const KAYNAKLAR = [
  {
    id: 'kosgeb',
    ad: 'KOSGEB',
    url: 'https://www.kosgeb.gov.tr/site/tr/genel/destekler/3/destek-programlari',
    anahtar: ['başvuru', 'destek', 'hibe', 'program', 'çağrı']
  },
  {
    id: 'tubitak',
    ad: 'TÜBİTAK TEYDEB',
    url: 'https://www.tubitak.gov.tr/tr/destekler/sanayi/ulusal-destek-programlari',
    anahtar: ['çağrı', 'başvuru', 'program', 'destek']
  },
  {
    id: 'tkdk',
    ad: 'TKDK / IPARD',
    url: 'https://www.tkdk.gov.tr/Sayfa/Duyurular',
    anahtar: ['çağrı', 'başvuru', 'dönem', 'ipard']
  },
  {
    id: 'trakyaka',
    ad: 'TRAKYAKA',
    url: 'https://www.trakyaka.org.tr/tr/duyuru',
    anahtar: ['mali destek', 'hibe', 'çağrı', 'başvuru']
  },
  {
    id: 'ticaret',
    ad: 'Ticaret Bakanlığı İhracat Destekleri',
    url: 'https://ticaret.gov.tr/destekler/ihracat-destekleri',
    anahtar: ['destek', 'hibe', 'başvuru', 'program']
  },
  {
    id: 'sanayi',
    ad: 'Sanayi Bakanlığı Yatırım Teşvik',
    url: 'https://www.sanayi.gov.tr/belgeler-ve-veriler/yatirim-tesvik-istatistikleri',
    anahtar: ['teşvik', 'yatırım', 'belge']
  },
  {
    id: 'istka',
    ad: 'İSTKA Mali Destek',
    url: 'https://www.istka.org.tr/mali-destek/',
    anahtar: ['çağrı', 'başvuru', 'hibe', 'mali destek']
  },
  {
    id: 'yatirimadestek',
    ad: 'yatirimadestek.gov.tr (Tüm Ajanslar)',
    url: 'https://www.yatirimadestek.gov.tr',
    anahtar: ['yeni', 'duyuru', 'hibe', 'teşvik', 'çağrı']
  }
];

const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.json');
const RAPOR_PATH    = path.join(__dirname, 'rapor.json');

// ─── Yardımcı: URL'yi indir ───────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CorlutsoHibeBot/1.0; +https://hibeler.corlutso.org.tr)',
        'Accept-Language': 'tr-TR,tr;q=0.9'
      },
      timeout: timeoutMs
    }, res => {
      // Yönlendirmeleri takip et
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımı')); });
  });
}

// ─── Sayfa özetini çıkar (hash yerine metin bazlı) ───────────────────────────
function ozetCikar(html, anahtarlar) {
  // HTML etiketlerini temizle
  const metin = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

  // Anahtar kelimelerin geçtiği cümleleri topla
  const cumleler = metin.split(/[.!?]\s+/);
  const ilgili = cumleler.filter(c =>
    anahtarlar.some(a => c.includes(a.toLowerCase()))
  ).slice(0, 20); // ilk 20 ilgili cümle

  return ilgili.join(' | ').substring(0, 3000);
}

// ─── Resend ile e-posta gönder ────────────────────────────────────────────────
async function epostaGonder(degisiklikler) {
  const apiKey = process.env.RESEND_API_KEY;
  const hedef  = process.env.BILDIRIM_EMAIL || 'cihan@corlutso.org.tr';

  if (!apiKey) {
    console.warn('⚠️  RESEND_API_KEY tanımlı değil, e-posta gönderilmedi.');
    return;
  }

  const satirlar = degisiklikler.map(d =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${d.ad}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px">${d.not}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><a href="${d.url}" style="color:#1a3a5c">Siteye git →</a></td>
    </tr>`
  ).join('');

  const html = `
  <div style="font-family:sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#1a3a5c;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">🔔 Çorlu TSO Hibe Motoru — Haftalık Güncelleme</h2>
      <p style="color:#93b8d8;margin:6px 0 0">${new Date().toLocaleDateString('tr-TR', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
    <div style="background:#fff;padding:20px;border:1px solid #eee;border-top:none">
      <p style="color:#555">Aşağıdaki kaynak sitelerde <strong>${degisiklikler.length} değişiklik</strong> tespit edildi. Lütfen kontrol edin ve gerekirse <code>data.json</code> dosyasını güncelleyin.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead>
          <tr style="background:#f5f5f3">
            <th style="padding:10px;text-align:left;font-size:13px">Kaynak</th>
            <th style="padding:10px;text-align:left;font-size:13px">Not</th>
            <th style="padding:10px;text-align:left;font-size:13px">Link</th>
          </tr>
        </thead>
        <tbody>${satirlar}</tbody>
      </table>
      <div style="margin-top:24px;padding:14px;background:#fffbeb;border-left:3px solid #fcd34d;border-radius:4px">
        <strong>Sonraki adım:</strong> Yeni bir program açıldıysa <code>data.json</code> dosyasına ekle ve commit at. Site otomatik güncellenir.
      </div>
    </div>
    <div style="padding:12px;text-align:center;font-size:12px;color:#999">
      Çorlu TSO Hibe Motoru · hibeler.corlutso.org.tr · Bu e-posta otomatik gönderilmiştir.
    </div>
  </div>`;

  const payload = JSON.stringify({
    from: 'Hibe Motor Bot <bot@corlutso.org.tr>',
    to: [hedef],
    subject: `🔔 Hibe Motoru: ${degisiklikler.length} kaynakta değişiklik tespit edildi`,
    html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`✉️  E-posta gönderildi → ${hedef}`);
          resolve();
        } else {
          console.error('E-posta hatası:', res.statusCode, body);
          reject(new Error(`Resend HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Ana fonksiyon ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 Haftalık tarama başladı — ${new Date().toLocaleString('tr-TR')}\n`);

  // Önceki snapshot'ı yükle
  const eskiSnapshot = fs.existsSync(SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    : {};

  const yeniSnapshot = {};
  const degisiklikler = [];
  const rapor = { tarih: new Date().toISOString(), kaynaklar: [] };

  for (const kaynak of KAYNAKLAR) {
    process.stdout.write(`  ⏳ ${kaynak.ad} taranıyor...`);
    try {
      const { status, body } = await fetchUrl(kaynak.url);
      const ozet = ozetCikar(body, kaynak.anahtar);
      yeniSnapshot[kaynak.id] = ozet;

      const eski = eskiSnapshot[kaynak.id] || '';
      const degisti = eski && ozet !== eski;

      const durum = degisti ? '🟡 DEĞİŞTİ' : (eski ? '✅ Aynı' : '🆕 İlk tarama');
      console.log(` ${durum} (HTTP ${status})`);

      rapor.kaynaklar.push({ id: kaynak.id, ad: kaynak.ad, durum, status });

      if (degisti) {
        degisiklikler.push({
          ad: kaynak.ad,
          url: kaynak.url,
          not: 'Sayfa içeriği geçen haftaya göre farklı — yeni duyuru olabilir.'
        });
      }
    } catch (err) {
      console.log(` ❌ Hata: ${err.message}`);
      rapor.kaynaklar.push({ id: kaynak.id, ad: kaynak.ad, durum: `HATA: ${err.message}` });
    }

    // Sunuculara aşırı yük bindirme
    await new Promise(r => setTimeout(r, 1500));
  }

  // Snapshot'ı güncelle
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(yeniSnapshot, null, 2), 'utf8');
  fs.writeFileSync(RAPOR_PATH, JSON.stringify(rapor, null, 2), 'utf8');

  console.log(`\n📊 Sonuç: ${degisiklikler.length} değişiklik tespit edildi.\n`);

  if (degisiklikler.length > 0) {
    await epostaGonder(degisiklikler);
  } else {
    console.log('📭 Değişiklik yok, e-posta gönderilmedi.');
  }
}

main().catch(err => {
  console.error('❌ Kritik hata:', err);
  process.exit(1);
});
