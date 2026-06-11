# Çorlu TSO — Hibe & Teşvik Motoru

`hibeler.corlutso.org.tr` için otomatik güncellenen hibe/teşvik veritabanı.

---

## Klasör yapısı

```
hibe-motor/
├── data.json                        ← Tüm program verisi burada
├── public/
│   └── index.html                   ← Site (JSON'dan veri çeker)
├── scripts/
│   ├── check-dates.js               ← Tarihi geçenleri kapandı yapar
│   ├── scraper.js                   ← Kaynak siteleri tarar, e-posta atar
│   └── package.json
└── .github/workflows/
    ├── check-dates.yml              ← Her gece 02:00 çalışır
    └── weekly-scrape.yml            ← Her Pazartesi 06:00 çalışır
```

---

## Kurulum (15 dakika)

### 1. GitHub repo oluştur
- github.com'da yeni bir **private** repo aç: `corlutso-hibe-motor`
- Bu klasörün içeriğini repoya yükle (git push)

### 2. GitHub Pages'i aç
- Repo → Settings → Pages
- Source: `Deploy from a branch` → `main` → `/public` klasörü
- Kaydet. Site `corlutso.github.io/corlutso-hibe-motor` adresinde yayınlanır.

### 3. Subdomain bağla
- DNS panelinde `hibeler.corlutso.org.tr` için CNAME kaydı ekle:
  ```
  hibeler  CNAME  corlutso.github.io
  ```
- Repo → Settings → Pages → Custom domain: `hibeler.corlutso.org.tr`

### 4. E-posta bildirimini ayarla
- [resend.com](https://resend.com)'da ücretsiz hesap aç (günde 100 e-posta ücretsiz)
- API Key al
- Repo → Settings → Secrets → Actions → New secret:
  - `RESEND_API_KEY` → Resend API anahtarın
  - `BILDIRIM_EMAIL` → cihan@corlutso.org.tr (veya istediğin adres)

---

## Otomatik güncelleme nasıl çalışır?

### Katman 1 — Her gece otomatik
`check-dates.yml` her gece 05:00'te çalışır:
- `data.json` içindeki tüm programların son tarihlerini kontrol eder
- Tarihi geçenleri → `"durum": "kapandı"` yapar
- Son 14 günde kapanacakları → `"durum": "kapanmak üzere"` yapar
- Değişiklik varsa otomatik commit atar, site güncellenir

### Katman 2 — Her Pazartesi yarı otomatik
`weekly-scrape.yml` her Pazartesi 09:00'da çalışır:
- KOSGEB, TÜBİTAK, TKDK, TRAKYAKA vb. 8 kaynak siteyi tarar
- Geçen haftayla karşılaştırır
- Değişiklik varsa sana e-posta atar
- **Sen** e-postayı okur, siteye girip kontrol eder, gerekirse `data.json`'a yeni program eklersin

---

## Yeni program eklemek

`data.json` dosyasını aç, en alta yeni bir satır ekle:

```json
{
  "id": 93,
  "baslik": "Yeni Program Adı",
  "tur": "Hibe",
  "kaynak": "KOSGEB",
  "grup": "Hibe Programları",
  "sektor": ["Tüm Sektörler"],
  "tutar": "500.000 ₺'ye kadar",
  "durum": "açık",
  "son": "2026-03-31",
  "aciklama": "Programın kısa açıklaması.",
  "url": "https://www.kosgeb.gov.tr"
}
```

Commit at → site 2-3 dakika içinde güncellenir.

---

## Destek türleri (tur alanı için)
`Hibe` · `Yatırım Teşviki` · `İstihdam Teşviki` · `Finansman Garantisi` · `Uygun Faizli Kredi` · `Sigorta / Güvence` · `Teknik Destek` · `Vergi/SGK Teşviki`

## Kategoriler (grup alanı için)
`Hibe Programları` · `Yatırım Teşvikleri` · `İhracat ve Uluslararasılaşma` · `İhracat Finansmanı (Eximbank)` · `Kredi Garantisi (KGF)` · `Uygun Faizli Krediler` · `AB ve Uluslararası Hibeler` · `Bölgesel Kalkınma (Ajanslar)` · `Vergi ve SGK Avantajları` · `İstihdam ve Personel Destekleri` · `Tarım Destekleri` · `Enerji ve Yeşil Dönüşüm` · `Turizm Destekleri` · `Savunma Sektörü`
