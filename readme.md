# Stremio Addon - Subtitrari-Noi.ro

Addon Stremio pentru subtitrări românești automate de pe subtitrari-noi.ro

## 🚀 Instalare Locală

### Pași:

1. **Clonează/creează proiectul:**
```bash
mkdir stremio-subtitrari-noi
cd stremio-subtitrari-noi
```

2. **Creează fișierele:**
   - `server.js` - codul principal
   - `package.json` - dependențele
   - `render.yaml` - configurare Render.com

3. **Instalează dependențele:**
```bash
npm install
```

4. **Pornește serverul local:**
```bash
npm start
```

5. **Testează addon-ul:**
   - Deschide: `http://localhost:7000/manifest.json`
   - Ar trebui să vezi manifestul JSON

6. **Instalează în Stremio:**
   - Deschide Stremio
   - Mergi la Addons
   - Click pe iconița 🧩 (Community Addons)
   - Introdu URL-ul: `http://localhost:7000/manifest.json`
   - Click "Install"

## 🌐 Deployment pe Render.com

### Pași:

1. **Creează un cont pe [Render.com](https://render.com)**

2. **Pune codul pe GitHub:**
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <URL-ul-repo-ului-tău>
git push -u origin main
```

3. **Conectează Render cu GitHub:**
   - Mergi pe Render Dashboard
   - Click "New +" → "Web Service"
   - Conectează repo-ul tău GitHub
   - Render va detecta automat `render.yaml`

4. **Configurează:**
   - Name: `stremio-subtitrari-noi`
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free (suficient pentru început)

5. **Deploy:**
   - Click "Create Web Service"
   - Așteaptă 2-3 minute pentru build

6. **Obține URL-ul public:**
   - După deployment: `https://stremio-subtitrari-noi.onrender.com`

7. **Instalează în Stremio:**
   - URL addon: `https://stremio-subtitrari-noi.onrender.com/manifest.json`

## 🔧 Personalizare

### Adaptează selectorii CSS:

În `server.js`, funcția `searchSubtitles`, trebuie să adaptezi selectorii CSS la structura reală a site-ului tău:

```javascript
// Exemplu - înlocuiește cu selectorii reali
$('.subtitle-item').each((i, elem) => {
    const $elem = $(elem);
    const title = $elem.find('.title').text().trim();
    const downloadUrl = $elem.find('a.download').attr('href');
    // ...
});
```

### Verifică structura HTML:

1. Deschide subtitrari-noi.ro în browser
2. Caută un film/serial
3. Click dreapta → "Inspect Element"
4. Identifică clasele/ID-urile pentru:
   - Container subtitrare
   - Titlu subtitrare
   - Link download
   - Info sezon/episod (pentru seriale)

### Exemple de selectori comuni:

```javascript
// Dacă structura e:
// <div class="sub-result">
//   <h3 class="sub-title">Film S01E01</h3>
//   <a href="/download/123" class="btn-download">Download</a>
// </div>

$('.sub-result').each((i, elem) => {
    const $elem = $(elem);
    const title = $elem.find('.sub-title').text().trim();
    const downloadUrl = $elem.find('.btn-download').attr('href');
});
```

## 🐛 Debugging

### Testează manual căutarea:

```bash
# Înlocuiește tt1234567 cu un IMDB ID real
curl https://subtitrari-noi.ro/search/tt1234567
```

### Verifică logurile:

```bash
# Local
npm start
# Vei vedea console.log-urile

# Pe Render
# Mergi în Dashboard → Logs
```

### Testează cu un film specific în Stremio:
1. Caută un film
2. Click pe film
3. Uită-te la iconița subtitrărilor (CC)
4. Ar trebui să apară addon-ul tău

## 📝 Note Importante

1. **Rate Limiting:** Adaugă delay-uri între cereri dacă e necesar
2. **Cache:** Consideră să adaugi caching pentru performanță
3. **CORS:** Render.com gestionează automat CORS pentru Stremio
4. **Free Tier:** Render.com oprește serviciul după 15 min inactivitate (pornește automat la cerere)

## 🔍 Troubleshooting

**Addon-ul nu apare în Stremio:**
- Verifică că URL-ul manifest.json e corect
- Asigură-te că serverul rulează
- Verifică că port-ul e corect

**Nu găsește subtitrări:**
- Verifică selectorii CSS
- Testează manual URL-urile de căutare
- Verifică console.log-urile pentru erori

**Erori pe Render:**
- Verifică logurile în Dashboard
- Asigură-te că toate dependențele sunt în package.json
- Verifică că Node.js version e compatibilă

## 📧 Support

Pentru probleme specifice cu structura site-ului subtitrari-noi.ro, verifică HTML-ul și adaptează selectorii în funcție de structura reală.