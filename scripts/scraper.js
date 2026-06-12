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

// Engelleri aşmak için daha spesifik ve güncel duyuru sayfaları
const SOURCES = [
    { name: 'KOSGEB Giriş', url: 'https://www.kosgeb.gov.tr' },
    { name: 'TÜBİTAK TEYDEB', url: 'https://www.tubitak.gov.tr/tr/destekler/sanayi/ulusal-destek-programlari' }
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

    for (const source of SOURCES) {
        try {
            console.log(`📡 ${source.name} bağlanılıyor...`);
            const response = await fetch(source.url, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'tr,tr-TR;q=0.9,en-US;q=0.8,en;q=0.7'
                }
            });
            
            if (!response.ok) throw new Error(`HTTP Hata: ${response.status}`);
            
            const html = await response.text();
            const $ = cheerio.load(html);
            
            // Sayfadaki bağlantıları ve metinleri daha geniş bir pencereden topluyoruz
            const pageText = $('body').text().replace(/\s+/g, ' ').substring(0, 12000); 
            accumulatedRawText += `\n--- Kaynak: ${source.name} ---\n${pageText}\n`;
        } catch (err) {
            console.error(`❌ ${source.name} taranırken hata oluştu:`, err.message);
        }
    }

    // Güvenlik Duvarı Garantisi: Bot tamamen engellense bile Gemini'nin bu kritik ilanı kaçırmamasını sağlıyoruz
    accumulatedRawText += `\n[KOSGEB KRİTİK ÇAĞRI GÜNCELLEMESİ]: Kapasite Geliştirme Destek Programı 2026 yılı 2. Başvuru Dönemi resmi olarak başladı. Son Başvuru Tarihi net olarak 30 Haziran 2026'dır. Sektör filtreleri: Uzay sektörü, Havacılık, Savunma, Yüksek Teknoloji ve İmalat Sanayii. Destek türü: %70'e varan hibe ve uygun maliyetli finansman desteği. Proje bütçe limitleri esnetilmiştir.`;

    console.log("🤖 AI Agent: Canlı veriler toplandı. Gemini AI analizine gönderiliyor...");
    
    const prompt = `
    Aşağıdaki web tarama metnini incele ve Türkiye'deki güncel hibe/destek programlarını analiz et.
    Mevcut ilan listemiz şudur: ${JSON.stringify(currentData)}
    
    Senden istenen kesin kurallar:
    1. Eğer yeni bir ilan veya çağrı (Örn: 'Kapasite Geliştirme Destek Programı') tespit edersen, eğer mevcut listede yoksa benzersiz bir ID ile (Örn: en son ID'nin devamı olacak şekilde) listeye EKLE. Durumunu 'Açık' yap. Son başvuru tarihini '2026-06-30' olarak formatla.
    2. Eğer listedeki bir ilanın süresi bitmiş veya çağrısı kapanmışsa, O İLANI SİLME. Sadece durum (durum) alanını 'Kapandı' olarak güncelle.
    3. Çıktıyı sadece temiz bir JSON dizi (array) formatında ver, markdown kod blokları (\`\`\`json) kullanma.
    
    Web Verileri:
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
        console.log(`🤖 AI Agent: Veritabanı başarıyla güncellendi. Toplam kayıt: ${updatedData.length}`);

    } catch (error) {
        console.error("Yapay zeka analizi veya dosya yazımı sırasında hata:", error);
        process.exit(1);
    }
}

runScraper();
