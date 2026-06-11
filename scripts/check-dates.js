/**
 * check-dates.js
 * Her gece çalışır. data.json içindeki programları şu kurala göre yönetir:
 *
 *  son tarihi > 14 gün sonra     → "açık"
 *  son tarihi 1-14 gün sonra     → "kapanmak üzere"
 *  son tarihi geçmiş, 0-15 gün   → "kapandı" (hâlâ göster)
 *  son tarihi 15+ gün geçmiş     → data.json'dan SİL
 *  "Süresiz"                     → dokunma, hep "açık"
 */

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data.json');
const bugun = new Date();
bugun.setHours(0, 0, 0, 0);

let data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const onceki = data.length;
const log = { guncellenen: [], silinen: [] };

// 1. Tarihi 15+ gün geçmişleri sil
data = data.filter(p => {
  if (p.son === 'Süresiz') return true;
  const son = new Date(p.son);
  const kalanGun = Math.ceil((son - bugun) / (1000 * 60 * 60 * 24));
  if (kalanGun < -15) {
    log.silinen.push(p);
    return false;
  }
  return true;
});

// 2. Kalan programların durumunu güncelle
data = data.map(p => {
  if (p.son === 'Süresiz') return { ...p, durum: 'açık' };
  const son = new Date(p.son);
  const kalanGun = Math.ceil((son - bugun) / (1000 * 60 * 60 * 24));
  let yeniDurum;
  if (kalanGun > 14)     yeniDurum = 'açık';
  else if (kalanGun > 0) yeniDurum = 'kapanmak üzere';
  else                   yeniDurum = 'kapandı';
  if (yeniDurum !== p.durum) {
    log.guncellenen.push({ ...p, yeniDurum });
    return { ...p, durum: yeniDurum };
  }
  return p;
});

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');

console.log(`\n📅 Tarih kontrolü — ${bugun.toLocaleDateString('tr-TR')}`);
console.log(`   Toplam: ${onceki} → ${data.length} program`);

if (log.silinen.length > 0) {
  console.log(`\n🗑️  ${log.silinen.length} program silindi (15+ gün geçmiş):`);
  log.silinen.forEach(p => console.log(`   - ${p.baslik} (son: ${p.son})`));
}

if (log.guncellenen.length > 0) {
  console.log(`\n🔄 ${log.guncellenen.length} program durumu güncellendi:`);
  log.guncellenen.forEach(p => console.log(`   - ${p.baslik}: "${p.durum}" → "${p.yeniDurum}"`));
}

if (log.silinen.length === 0 && log.guncellenen.length === 0) {
  console.log('   ✅ Değişiklik yok.');
}

console.log(`\n   Açık: ${data.filter(p=>p.durum==='açık').length}`);
console.log(`   Kapanmak üzere: ${data.filter(p=>p.durum==='kapanmak üzere').length}`);
console.log(`   Kapandı: ${data.filter(p=>p.durum==='kapandı').length}\n`);
