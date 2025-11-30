// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// Definirea manifestului addon-ului
const manifest = {
    id: 'ro.titrari.stremio',
    version: '1.0.2',
    name: 'Titrari.ro',
    description: 'Subtitrări în limba română de pe titrari.ro - cel mai mare site de subtitrări românești',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    logo: 'https://titrari.ro/images/logo.png'
};

const builder = new addonBuilder(manifest);

// Cache pentru a evita apeluri repetate
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 minute

// Headers comune pentru toate request-urile
const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': 'https://titrari.ro/'
};

// Funcție pentru normalizare text
function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Funcție pentru a extrage ID-ul subtitrării din link
function extractSubtitleId(href) {
    const match = href.match(/id=(\d+)/);
    return match ? match[1] : null;
}

// Funcție pentru căutare pe titrari.ro
async function searchByImdbId(imdbId, type, season, episode) {
    const cacheKey = `search:${imdbId}:${season || 'x'}:${episode || 'x'}`;
    
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log('📦 Cache hit');
            return cached.data;
        }
    }
    
    try {
        // Titrari.ro folosește "numaicautamcaneiesepenas" (Căutare avansată) pentru IMDB ID
        // z5 = IMDB ID (fără "tt")
        // z8=1 = limba română
        // z11=0 = toate tipurile (filme + seriale)
        const cleanImdbId = imdbId.replace('tt', '');
        const searchUrl = `https://titrari.ro/index.php?page=numaicautamcaneiesepenas&z7=&z2=&z5=${cleanImdbId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;
        
        console.log(`🔍 Caut pe titrari.ro: ${imdbId}`);
        console.log(`🔗 URL: ${searchUrl}`);
        
        const response = await axios.get(searchUrl, {
            headers: COMMON_HEADERS,
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const subtitles = [];
        
        // Parcurgem toate rândurile de subtitrări
        // Structura: fiecare subtitrare e într-un <tr> care conține get.php?id=
        $('a[href*="get.php?id="]').each((i, elem) => {
            const $elem = $(elem);
            const downloadLink = $elem.attr('href');
            const subId = extractSubtitleId(downloadLink);
            
            if (!subId) return;
            
            // Găsim rândul părinte (tr) care conține toate detaliile
            const $row = $elem.closest('tr');
            
            // Găsim toate celulele din acest rând
            const allText = $row.text();
            
            // Extragem titlul filmului/serialului
            let title = '';
            $row.find('h1 a, .row1 a[style*="color:black"]').each((j, titleElem) => {
                const text = $(titleElem).text().trim();
                if (text && text.length > 3) {
                    title = text;
                }
            });
            
            // Dacă nu am găsit titlul în link, îl căutăm în h1
            if (!title) {
                const h1Text = $row.find('h1').text().trim();
                if (h1Text) title = h1Text;
            }
            
            // Extragem detalii
            let fps = '';
            let translator = '';
            let downloads = '0';
            let releaseInfo = '';
            
            // FPS - căutăm în text
            const fpsMatch = allText.match(/Framerate[:\s]*([0-9.]+)\s*FPS/i);
            if (fpsMatch) fps = fpsMatch[1];
            
            // Traducător - căutăm în text
            const translatorMatch = allText.match(/Traducator[:\s]*([^\n\r]+?)(?:Uploader|Framerate|$)/i);
            if (translatorMatch) {
                translator = translatorMatch[1]
                    .trim()
                    .replace(/\s+/g, ' ')
                    .replace(/\[|\]/g, '')
                    .substring(0, 50);
            }
            
            // Număr descărcări
            const downloadsMatch = allText.match(/Descarcari[:\s]*(\d+)/i);
            if (downloadsMatch) downloads = downloadsMatch[1];
            
            // Comentariu (release info)
            const commentMatch = allText.match(/Comentariu[:\s]*([^\n]+)/i);
            if (commentMatch) {
                releaseInfo = commentMatch[1].trim().substring(0, 80);
            }
            
            // Pentru seriale, verificăm dacă este episodul corect
            if (type === 'series' && season && episode) {
                const textToCheck = title + ' ' + releaseInfo + ' ' + allText;
                
                // Pattern-uri pentru identificare sezon/episod
                const patterns = [
                    new RegExp(`S0*${season}E0*${episode}(?!\\d)`, 'i'),
                    new RegExp(`${season}x0*${episode}`, 'i'),
                    new RegExp(`Sezon[ul\\s]*0*${season}[\\s.,E-]*(?:ep\\.?|episod)[\\s]*0*${episode}`, 'i')
                ];
                
                const matches = patterns.some(p => p.test(textToCheck));
                
                if (!matches) {
                    console.log(`⏭️  Skip: ${title} - nu este S${season}E${episode}`);
                    return;
                }
            }
            
            // Construim titlul descriptiv
            let displayTitle = '🇷🇴 Titrari.ro';
            
            if (title) {
                displayTitle += ` - ${title}`;
            }
            
            if (releaseInfo && !title.includes(releaseInfo.substring(0, 20))) {
                displayTitle += ` [${releaseInfo.substring(0, 40)}]`;
            }
            
            if (fps) {
                displayTitle += ` [${fps} FPS]`;
            }
            
            if (translator && translator !== 'undefined') {
                displayTitle += ` (${translator})`;
            }
            
            if (downloads !== '0') {
                displayTitle += ` ↓${downloads}`;
            }
            
            const fullUrl = downloadLink.startsWith('http') 
                ? downloadLink 
                : `https://titrari.ro/${downloadLink}`;
            
            subtitles.push({
                id: `titrari:${subId}`,
                url: fullUrl,
                lang: 'ron',
                title: displayTitle,
                downloads: parseInt(downloads) || 0
            });
            
            console.log(`✅ Găsită: ${displayTitle}`);
        });
        
        // Sortăm după popularitate (număr descărcări)
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        console.log(`📊 Total: ${subtitles.length} subtitrări`);
        
        if (subtitles.length > 0) {
            cache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
        }
        
        return subtitles;
        
    } catch (error) {
        console.error('❌ Eroare la căutare:', error.message);
        return [];
    }
}

// Funcție principală de căutare subtitrări
async function searchSubtitles(imdbId, type, season, episode) {
    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 Cerere: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
        console.log(`⏰ ${new Date().toISOString()}`);
        
        // Căutăm pe titrari.ro
        const subtitles = await searchByImdbId(imdbId, type, season, episode);
        
        console.log(`\n📊 Rezultat final: ${subtitles.length} subtitrări`);
        console.log('='.repeat(60));
        
        return subtitles;
        
    } catch (error) {
        console.error('❌ Eroare generală:', error.message);
        return [];
    }
}

// Handler pentru cereri de subtitrări
builder.defineSubtitlesHandler(async (args) => {
    console.log('\n' + '🔥'.repeat(30));
    console.log('📥 CERERE STREMIO');
    console.log('📥 Args:', JSON.stringify(args, null, 2));
    
    const { type, id } = args;
    
    // Extrage IMDB ID
    const imdbId = id.split(':')[0];
    
    // Pentru seriale, extrage sezonul și episodul
    let season, episode;
    if (type === 'series') {
        const parts = id.split(':');
        season = parts[1];
        episode = parts[2];
    }

    try {
        const subtitles = await searchSubtitles(imdbId, type, season, episode);
        
        console.log(`\n📤 RĂSPUNS: ${subtitles.length} subtitrări`);
        console.log('🔥'.repeat(30) + '\n');

        return { subtitles };
    } catch (error) {
        console.error('❌ EROARE:', error);
        return { subtitles: [] };
    }
});

// Pornește serverul
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { 
    port: port,
    hostname: '0.0.0.0'
});

console.log('\n' + '🚀'.repeat(30));
console.log('✅ Addon Titrari.ro v1.0.2 PORNIT!');
console.log(`📍 Port: ${port}`);
console.log(`🌐 Manifest Local: http://localhost:${port}/manifest.json`);
console.log(`🌐 Pentru Render.com: https://YOUR-APP.onrender.com/manifest.json`);
console.log('🚀'.repeat(30) + '\n');
