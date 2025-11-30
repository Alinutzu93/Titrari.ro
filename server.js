// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// Definirea manifestului addon-ului
const manifest = {
    id: 'ro.titrari.stremio',
    version: '1.0.1',
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

// Funcție pentru a extrage ID-ul subtitrării din link sau text
function extractSubtitleId(text) {
    const match = text.match(/id[=:](\d+)/i);
    return match ? match[1] : null;
}

// Funcție NOUĂ: căutare directă folosind pagina cautamsavedem
async function searchDirectByImdb(imdbId, type, season, episode) {
    const cacheKey = `direct:${imdbId}:${season || 'x'}:${episode || 'x'}`;
    
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log('📦 Cache hit');
            return cached.data;
        }
    }
    
    try {
        const cleanImdbId = imdbId.replace('tt', '');
        
        // Încercăm căutarea simplă după IMDB
        // Format URL: index.php?page=cautare&z1=2&z2=IMDB_ID&z3=1&z4=1
        const searchUrl = `https://titrari.ro/index.php?page=cautare&z1=2&z2=${cleanImdbId}&z3=1&z4=1`;
        
        console.log(`🔍 Căutare simplă: ${imdbId}`);
        console.log(`🔗 URL: ${searchUrl}`);
        
        const response = await axios.get(searchUrl, {
            headers: COMMON_HEADERS,
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const subtitles = [];
        
        // Metoda 1: Căutăm direct link-uri get.php
        $('a[href*="get.php?id="]').each((i, elem) => {
            const $elem = $(elem);
            const href = $elem.attr('href');
            const subId = extractSubtitleId(href);
            
            if (subId) {
                // Găsim contextul (container-ul părinte)
                const $container = $elem.closest('tr, td, div, article');
                const allText = $container.text();
                
                // Extragem detalii
                let title = '';
                let fps = '';
                let translator = '';
                let downloads = '0';
                let releaseInfo = '';
                
                // Titlu - cautăm în link-uri cu cautamsavedem sau în heading-uri
                $container.find('a[href*="cautamsavedem"], strong, b, h3, h4').each((j, titleElem) => {
                    const text = $(titleElem).text().trim();
                    if (text && text.length > 3 && text.length < 200) {
                        title = text;
                    }
                });
                
                // FPS
                const fpsMatch = allText.match(/(\d+(?:\.\d+)?)\s*FPS/i);
                if (fpsMatch) fps = fpsMatch[1];
                
                // Release info
                const releaseMatch = allText.match(/([A-Z0-9][\w.-]{10,}(?:BluRay|WEB-?DL|WEBRip|HDTV|BRRip|BDRip)[\w.-]*)/i);
                if (releaseMatch) releaseInfo = releaseMatch[1];
                
                // Traducător
                const translatorMatch = allText.match(/Traducator[:\s]*([^\n\r]+?)(?:Uploader|Framerate|FPS|Numar|$)/i);
                if (translatorMatch) {
                    translator = translatorMatch[1].trim().replace(/\s+/g, ' ').substring(0, 40);
                }
                
                // Descărcări
                const downloadsMatch = allText.match(/Descarcari[:\s]*(\d+)/i);
                if (downloadsMatch) downloads = downloadsMatch[1];
                
                // Pentru seriale, verificăm sezon/episod
                if (type === 'series' && season && episode) {
                    const patterns = [
                        new RegExp(`S0*${season}[\\s.E-]*E?0*${episode}(?!\\d)`, 'i'),
                        new RegExp(`${season}x0*${episode}`, 'i'),
                        new RegExp(`Sezon[ul\\s]*0*${season}[\\s.,E-]*(?:Ep\\.?|Episod)[\\s]*0*${episode}`, 'i')
                    ];
                    
                    const textToCheck = title + ' ' + releaseInfo + ' ' + allText;
                    const matches = patterns.some(p => p.test(textToCheck));
                    
                    if (!matches) {
                        console.log(`⏭️  Skip: nu este S${season}E${episode}`);
                        return;
                    }
                }
                
                // Construim titlul display
                let displayTitle = '🇷🇴 Titrari.ro';
                
                if (title && !title.includes('Descarca')) {
                    displayTitle += ` - ${title.substring(0, 60)}`;
                } else if (releaseInfo) {
                    displayTitle += ` - ${releaseInfo}`;
                }
                
                if (fps) displayTitle += ` [${fps} FPS]`;
                if (translator) displayTitle += ` (${translator})`;
                if (downloads !== '0') displayTitle += ` ↓${downloads}`;
                
                const fullUrl = href.startsWith('http') ? href : `https://titrari.ro/${href}`;
                
                subtitles.push({
                    id: `titrari:${subId}`,
                    url: fullUrl,
                    lang: 'ron',
                    title: displayTitle,
                    downloads: parseInt(downloads) || 0
                });
                
                console.log(`✅ Găsită: ${displayTitle}`);
            }
        });
        
        // Metoda 2: Căutăm în text pentru pattern-uri de ID-uri
        if (subtitles.length === 0) {
            console.log('🔄 Încerc metoda alternativă...');
            
            // Căutăm toate aparițiile de "Descarcari:" urmate de un link
            const pageText = $.html();
            const idMatches = pageText.match(/get\.php\?id=(\d+)/g);
            
            if (idMatches) {
                console.log(`📋 Găsite ${idMatches.length} potențiale subtitrări în HTML`);
                
                // Pentru fiecare ID găsit, creăm o subtitrare
                const uniqueIds = [...new Set(idMatches.map(m => m.match(/\d+/)[0]))];
                
                uniqueIds.forEach((id, index) => {
                    subtitles.push({
                        id: `titrari:${id}`,
                        url: `https://titrari.ro/get.php?id=${id}`,
                        lang: 'ron',
                        title: `🇷🇴 Titrari.ro - Subtitrare #${index + 1}`,
                        downloads: 0
                    });
                });
            }
        }
        
        // Sortare după popularitate
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        console.log(`📊 Total: ${subtitles.length} subtitrări`);
        
        if (subtitles.length > 0) {
            cache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
        }
        
        return subtitles;
        
    } catch (error) {
        console.error('❌ Eroare:', error.message);
        return [];
    }
}

// Funcție principală de căutare subtitrări
async function searchSubtitles(imdbId, type, season, episode) {
    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 Cerere: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
        console.log(`⏰ ${new Date().toISOString()}`);
        
        // Căutare directă
        const subtitles = await searchDirectByImdb(imdbId, type, season, episode);
        
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
console.log('✅ Addon Titrari.ro v1.0.1 PORNIT!');
console.log(`📍 Port: ${port}`);
console.log(`🌐 Manifest Local: http://localhost:${port}/manifest.json`);
console.log(`🌐 Pentru Render.com: https://YOUR-APP.onrender.com/manifest.json`);
console.log('🚀'.repeat(30) + '\n');
