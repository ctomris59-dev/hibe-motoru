const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

// GitHub Actions ortamında secrets'tan gelen API anahtarını kullanıyoruz
const aiApiKey = process.env.GEMINI_API_KEY;
if (!aiApiKey) {
    console.error("HATA: GEMINI_API_KEY çevre değişkeni bulunamadı!");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: aiApiKey });
const dataPath = path.join(__dirname, '../data.json');

// Sabit kaynak listesi (Örnek olarak KOSGEB ve TÜBİTAK adresleri)
const SOURCES = [
    { name: 'KOSGEB', url: 'https://www.kosgeb.gov.tr/site/tr/baglanti/destekler' },
    { name: 'TÜBİTAK TEYDEB', url: 'https://www.tubitak.gov.tr/tr/destekler/sanayi/ulusal-destek-programlari' }
];

async function runScraper() {
    console.log("🤖 AI Agent: Hibe motoru taraması başlatıldı...");
    
    // 1. Mevcut veritabanını oku (Eski verileri kaybetmemek için)
    let currentData = [];
    if (fs.existsSync(dataPath)) {
        try {
            const fileContent = fs.readFileSync(dataPath, 'utf8');
            currentData = JSON.parse(fileContent || '[]');
        } catch (e) {
            console.log("Mevcut veri okunurken hata oluştu, sıfırdan başlanıyor.");
            currentData = [];
        }
    }

    console.log(`Mevcut veritabanında ${currentData.length} adet ilan kayıtlı.`);

    // 2. Siteleri simüle ederek/okuyarak ham veri topla
    // Not: Gerçek senaryoda buralardan dinamik HTML çekilir (Fetch/Axios)
    let fetchedRawText = "KOSGEB Girişimci Destek Programı sürekli açık. TÜBİTAK TEYDEB 1501 ve 1507 çağrıları güncellendi, başvurular kesintisiz devam ediyor. Eski dönemsel KOBİGEL çağrılarının süreleri bitti.";

    // 3. Gemini AI'dan sitelerdeki ilanların durum analizini isteyelim
    console.log("🤖 AI Agent: Gemini AI ile güncellik analizi yapılıyor...");
    
    const prompt = `
    Aşağıdaki ham metni incele ve Türkiye'deki hibe/destek programlarını analiz et.
    Mevcut ilan listemiz şudur: ${JSON.stringify(currentData)}
    
    Senden istenen kurallar:
    1. Eğer yeni bir ilan tespit edersen listeye ekle, durumunu 'Açık' veya 'Süresiz' yap.
    2. Eğer listedeki bir ilanın süresi bitmiş veya çağrısı kapanmışsa, O İLANI SİLME. Sadece durum (status) alanını 'Kapandı' olarak güncelle.
    3. Çıktıyı sadece temiz bir JSON dizi (array) formatında ver, markdown kod blokları (\`\`\`json) kullanma.
    
    Ham kaynak metni:
    ${fetchedRawText}
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        let aiResult = response.text.trim();
        
        // JSON dışı olası temizlik işlemleri
        if (aiResult.startsWith('```')) {
            aiResult = aiResult.replace(/```json|```/g, '').trim();
        }

        const updatedData = JSON.parse(aiResult);

        // 4. Güncellenmiş veritabanını diske yaz
        fs.writeFileSync(dataPath, JSON.stringify(updatedData, null, 2), 'utf8');
        console.log(`🤖 AI Agent: Veritabanı başarıyla güncellendi. Toplam kayıt: ${updatedData.length}`);

    } catch (error) {
        console.error("Yapay zeka analizi veya dosya yazımı sırasında hata:", error);
        process.exit(1);
    }
}

runScraper();
