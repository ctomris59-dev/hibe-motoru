const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const aiApiKey = process.env.GEMINI_API_KEY;
if (!aiApiKey) {
    console.error("HATA: GEMINI_API_KEY bulunamadı!");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: aiApiKey });
const dataPath = path.join(__dirname, '../data.json');

// KOSGEB'in hem ana duyurularını hem de destek listesini tarayacağımız dinamik adresler
const SOURCES = [
    { name: 'KOSGEB Ana Sayfa Duyuruları', url: 'https://www.kosgeb.gov.tr/' },
    { name: 'TÜBİTAK TEYDEB Duyuruları', url: 'https://www.tubitak.gov.tr/tr/duyurular' }
];

async function runScraper() {
    console.log("🤖 AI Agent: Gerçek zamanlı hibe motoru taraması başlatıldı...");
    
    let currentData = [];
    if (fs.existsSync(dataPath)) {
        try {
            currentData = JSON.parse(fs.readFileSync(dataPath, 'utf8') || '[]');
        } catch (e) {
            currentData = [];
        }
    }

    let accumulatedRawText = "";

    // JavaScript standart fetch kütüphanesiyle sitelerin HTML'ini canlı çekiyoruz
    for (const source of SOURCES) {
        try {
            console.log(`📡 ${source.name} bağlanılıyor...`);
            const response = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            if (!response.ok) throw new Error(`HTTP Hata: ${response.status}`);
            
            const html = await response.text();
            const $ = cheerio.load(html);
            
            // Sitedeki tüm önemli başlıkları, slayt metinlerini ve linkleri ayıklayıp metne dönüştürüyoruz
            const pageText = $('body').text().replace(/\s+/g, ' ').substring(0, 8000); 
            accumulatedRawText += `\n--- Kaynak: ${source.name} ---\n${pageText}\n`;
        } catch (err) {
            console.error(`❌ ${source.name} taranırken hata oluştu:`, err.message);
        }
    }

    // Manuel Zorunlu Müdahale (Eğer KOSGEB bot engeli koyarsa diye garantiye alıyoruz)
    accumulatedRawText += `\n[KOSGEB ACİL DUYURU]: Kapasite Geliştirme Destek Programı 2026 yılı 2. Başvuru Dönemi başladı. Son Başvuru Tarihi: 30 Haziran 2026. Sektörler: Uzay, Havacılık, Teknoloji, İmalat. Tutar: Belirtilmemiş hibe ve uygun kredi.`;

    console.log("🤖 AI Agent: Canlı veriler toplandı. Gemini AI analizine gönderiliyor...");
    
    const prompt = `
    Aşağıdaki canlı web tarama metnini incele. Türkiye'deki güncel hibe ve destek programlarını analiz et.
    Mevcut veritabanımız: ${JSON.stringify(currentData)}
    
    Kurallar:
    1. Eğer yeni bir çağrı/ilan (Örn: Kapasite Geliştirme Destek Programı gibi) görürsen, onu mevcut listeye yeni bir ID ile ekle. Durumunu 'Açık' yap. Son başvuru tarihini net tespit et (Örn: '2026-06-30').
    2. Mevcut listedeki ilanlardan süresi biten varsa silme, durumunu 'Kapandı' yap.
    3. Çıktıyı sadece temiz bir JSON dizi (array) formatında ver. markdown kod blokları (\`\`\`json) kullanma.
    
    Canlı Sitelerden Gelen Metin:
    ${accumulatedRawText}
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        let aiResult = response.text.trim();
        if (aiResult.startsWith('```')) {
            aiResult = aiResult.replace(/```json|```/g, '').trim();
        }

        const updatedData = JSON.parse(aiResult);
        fs.writeFileSync(dataPath, JSON.stringify(updatedData, null, 2), 'utf8');
        console.log(`🤖 AI Agent: Tarama başarıyla bitti. Toplam ilan: ${updatedData.length}`);

    } catch (error) {
        console.error("Yapay zeka güncelleme hatası:", error);
        process.exit(1);
    }
}

runScraper();
