/**
 * /api/match — Vercel Serverless Function
 *
 * Kullanıcının seçtiği Sektör / Şirket Ölçeği / Yatırım Amacı bilgilerini
 * ve data.json içindeki tüm programları Gemini'ye gönderir. Gemini, firmaya
 * en uygun programları seçer, her biri için 0-100 arası bir skor ve kısa bir
 * gerekçe (Türkçe, ~12 kelime) döndürür.
 *
 * Request body (POST, JSON):
 *   { sektor: string, olcek: string, hedef: string, programlar: Array }
 *
 * Response (JSON):
 *   { sonuclar: [ { id: number, skor: number, gerekce: string }, ... ] }
 *
 * Gerekli ortam değişkeni: GEMINI_API_KEY (Vercel → Settings → Environment Variables)
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ hata: 'Sadece POST isteği kabul edilir.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ hata: 'Sunucu yapılandırma hatası: GEMINI_API_KEY tanımlı değil.' });
  }

  const { sektor, olcek, hedef, programlar } = req.body || {};

  if (!Array.isArray(programlar) || programlar.length === 0) {
    return res.status(400).json({ hata: 'Geçerli bir program listesi gönderilmedi.' });
  }
  if (!sektor && !olcek && !hedef) {
    return res.status(400).json({ hata: 'En az bir kriter (sektör, ölçek veya hedef) seçilmeli.' });
  }

  // Gemini'ye gönderilecek program özetleri — token tasarrufu için sadece
  // eşleştirme için gerekli alanlar gönderilir, açıklama metinleri kısaltılır.
  const programOzetleri = programlar.map(p => ({
    id: p.id,
    baslik: p.baslik,
    kaynak: p.kaynak,
    grup: p.grup,
    sektor: p.sektor,
    tutar: p.tutar,
    aciklama: (p.aciklama || '').substring(0, 160)
  }));

  const kriterMetni = [
    sektor ? `Sektör: ${sektor}` : null,
    olcek ? `Şirket ölçeği: ${olcek}` : null,
    hedef ? `Yatırım amacı: ${hedef}` : null
  ].filter(Boolean).join('\n');

  const prompt = `Sen bir hibe/teşvik danışmanısın. Aşağıdaki firma profiline göre, verilen program listesinden EN UYGUN olanları seç ve puanla.

FİRMA PROFİLİ:
${kriterMetni}

KURALLAR:
1. Sadece gerçekten uygun olan programları döndür (en fazla 15 program, en az 0 — alakasızsa boş dizi).
2. Her program için 0-100 arası bir uygunluk skoru ver. 70+ güçlü eşleşme, 40-69 olası eşleşme, 40 altını döndürme.
3. Her program için EN FAZLA 12 kelimelik, Türkçe, somut bir gerekçe yaz (örn: "KOBİ ölçeğinde Ar-Ge projelerine uygun, sektörünüzle örtüşüyor").
4. Skora göre büyükten küçüğe sıralı döndür.
5. Sadece JSON döndür, başka hiçbir metin/markdown ekleme.

PROGRAM LİSTESİ:
${JSON.stringify(programOzetleri)}

Çıktı formatı (sadece bu, başka hiçbir şey yazma):
[{"id":123,"skor":85,"gerekce":"..."}]`;

  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 3000 }
  });

  // Gemini'nin geçici yoğunluk (503 / "high demand") hatalarına karşı
  // otomatik yeniden deneme. Her deneme arasında kısa bir bekleme var,
  // toplamda en fazla 3 deneme yapılır.
  const MAX_DENEME = 3;
  const BEKLEME_MS = 1500;
  let sonHata = null;

  for (let deneme = 1; deneme <= MAX_DENEME; deneme++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          signal: AbortSignal.timeout(25000)
        }
      );

      const data = await response.json();

      if (!response.ok) {
        const mesaj = data?.error?.message || `HTTP ${response.status}`;
        const yogunluk = response.status === 503 || /overloaded|high demand/i.test(mesaj);
        if (yogunluk && deneme < MAX_DENEME) {
          sonHata = mesaj;
          await new Promise(r => setTimeout(r, BEKLEME_MS * deneme));
          continue; // bir sonraki denemeye geç
        }
        return res.status(502).json({ hata: `Gemini API hatası: ${mesaj}` });
      }

      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '[]';
      const temiz = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

      let sonuclar;
      try {
        sonuclar = JSON.parse(temiz);
      } catch (parseErr) {
        // Kesik yanıt kurtarma — son tam elemanı bul, oradan kapat.
        const sonTamKapanis = temiz.lastIndexOf('},');
        if (sonTamKapanis > 0) {
          try {
            sonuclar = JSON.parse(temiz.substring(0, sonTamKapanis + 1) + ']');
          } catch (e2) {
            return res.status(502).json({ hata: 'Gemini yanıtı işlenemedi (kesik veya geçersiz JSON).' });
          }
        } else {
          return res.status(502).json({ hata: 'Gemini yanıtı işlenemedi (geçersiz JSON).' });
        }
      }

      if (!Array.isArray(sonuclar)) {
        return res.status(502).json({ hata: 'Gemini beklenmeyen bir format döndürdü.' });
      }

      // Güvenlik: sadece geçerli id/skor içeren, gönderdiğimiz programlar
      // listesinde gerçekten var olan kayıtları kabul et.
      const gecerliIdler = new Set(programlar.map(p => p.id));
      const temizSonuclar = sonuclar
        .filter(s => s && gecerliIdler.has(s.id) && typeof s.skor === 'number')
        .map(s => ({
          id: s.id,
          skor: Math.max(0, Math.min(100, Math.round(s.skor))),
          gerekce: typeof s.gerekce === 'string' ? s.gerekce.substring(0, 200) : ''
        }))
        .sort((a, b) => b.skor - a.skor);

      return res.status(200).json({ sonuclar: temizSonuclar });

    } catch (e) {
      sonHata = e.name === 'TimeoutError' ? 'Gemini isteği zaman aşımına uğradı.' : e.message;
      if (deneme < MAX_DENEME) {
        await new Promise(r => setTimeout(r, BEKLEME_MS * deneme));
        continue;
      }
      return res.status(500).json({ hata: `Sunucu hatası: ${sonHata}` });
    }
  }

  // Tüm denemeler tükendi (yoğunluk hatası devam ediyor)
  return res.status(502).json({ hata: `Gemini şu anda yoğun, lütfen birkaç saniye sonra tekrar deneyin. (${sonHata || 'yoğunluk'})` });
}
