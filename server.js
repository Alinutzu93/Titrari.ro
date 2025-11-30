// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// Definirea manifestului addon-ului
const manifest = {
    id: 'ro.titrari.stremio',
    version: '1.0.0',
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

// Funcție pentru a obține informații despre film/serial de la OMDB
async function getMediaInfo(imdbId) {
    const cacheKey = `info:${imdbId}`;
    
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log('📦 Folosesc info din cache pentru', imdbId);
            return cached.data;
        }
    }
    
    try {
        // API OMDB public (key limitat, dar suficient pentru teste)
        const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=3e4cb0d`;
        console.log(`🔍 Obțin info de la OMDB: ${imdbId}`);
        
        const response = await axios.get(url, { timeout: 10000 });
        
        if (response.data && response.data.Title) {
            const info = {
                title: response.data.Title,
                year: response.data.Year,
                type: response.data.Type
            };
            
            cache.set(cacheKey, { data: info, timestamp: Date.now() });
            console.log(`✅ Titlu: ${info.title} (${info.year})`);
            return info;
        }
    } catch (error) {
        console.log('⚠️ OMDB nu răspunde:', error.message);
    }
    
    return null;
}

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

// Funcție pentru căutare pe titrari.ro folosind IMDB ID
async function searchByImdbId(imdbId) {
    const cacheKey = `search:${imdbId}`;
    
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log('📦 Folosesc rezultate din cache');
            return cached.data;
        }
    }
    
    try {
        // Titrari.ro folosește "cautarecutare" pentru căutare avansată
        // Parametrii: z5=IMDB_ID (fără 'tt'), z8=1 (română), z11=0 (toate tipurile)
        const cleanImdbId = imdbId.replace('tt', '');
        const searchUrl = `https://titrari.ro/index.php?page=cautarecutare&z7=&z2=&z5=${cleanImdbId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;
        
        console.log(`🔍 Caut pe titrari.ro: ${imdbId}`);
        console.log(`🔗 URL: ${searchUrl}`);
        
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
                'Referer': 'https://titrari.ro/'
            },
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const subtitles = [];
        
        // Titrari.ro afișează subtitrări în div-uri cu linkuri "Descarca"
        // Structura: <a href="get.php?id=XXXXX">Descarca</a>
        $('a[href*="get.php"]').each((i, elem) => {
            const $elem = $(elem);
            const downloadLink = $elem.attr('href');
            
            if (downloadLink && downloadLink.includes('get.php?id=')) {
                // Găsim container-ul părinte pentru detalii
                const $container = $elem.closest('td').parent();
                
                // Extragem informații
                let title = '';
                let fps = '';
                let translator = '';
                let downloads = '';
                let details = '';
                
                // Căutăm titlul (de obicei în link-uri cu moviepics)
                $container.find('a[href*="moviepics"]').each((j, titleElem) => {
                    const altText = $(titleElem).find('img').attr('alt');
                    if (altText && altText.includes('Subtitrare')) {
                        title = altText.replace('Subtitrare ', '').trim();
                    }
                });
                
                // Extragem toate detaliile din text
                const containerText = $container.text();
                
                // FPS
                const fpsMatch = containerText.match(/Framerate:\s*([0-9.]+)\s*FPS/i);
                if (fpsMatch) fps = fpsMatch[1];
                
                // Traducător
                const translatorMatch = containerText.match(/Traducator:\s*([^\n]+)/i);
                if (translatorMatch) translator = translatorMatch[1].trim().split('Uploader')[0].trim();
                
                // Număr descărcări
                const downloadsMatch = containerText.match(/Descarcari:\s*(\d+)/i);
                if (downloadsMatch) downloads = downloadsMatch[1];
                
                // Construim titlul descriptiv
                let displayTitle = '🇷🇴 Titrari.ro';
                if (title) displayTitle += ` - ${title}`;
                if (fps) displayTitle += ` [${fps} FPS]`;
                if (translator) displayTitle += ` (${translator})`;
                if (downloads) displayTitle += ` [↓${downloads}]`;
                
                subtitles.push({
                    id: `titrari:${downloadLink}`,
                    url: downloadLink.startsWith('http') ? downloadLink : `https://titrari.ro/${downloadLink}`,
                    lang: 'ron',
                    title: displayTitle,
                    fps: fps,
                    translator: translator,
                    downloads: parseInt(downloads) || 0
                });
                
                console.log(`✅ Găsită: ${displayTitle}`);
            }
        });
        
        // Sortăm după numărul de descărcări (cele mai populare primul)
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        if (subtitles.length > 0) {
            console.log(`🎯 Total găsite: ${subtitles.length} subtitrări`);
            cache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
        } else {
            console.log('❌ Nu s-au găsit subtitrări');
        }
        
        return subtitles;
        
    } catch (error) {
        console.error('❌ Eroare la căutare:', error.message);
        return [];
    }
}

// Funcție pentru filtrare subtitrări pentru seriale
function filterForEpisode(subtitles, season, episode) {
    if (!season || !episode) return subtitles;
    
    const filtered = subtitles.filter(sub => {
        const titleLower = sub.title.toLowerCase();
        
        // Verificăm mai multe formate: S01E01, S1E1, 1x01, etc.
        const patterns = [
            new RegExp(`s0*${season}e0*${episode}`, 'i'),
            new RegExp(`${season}x0*${episode}`, 'i'),
            new RegExp(`sezon\\s*0*${season}.*ep\\.?\\s*0*${episode}`, 'i'),
            new RegExp(`season\\s*0*${season}.*episode\\s*0*${episode}`, 'i')
        ];
        
        return patterns.some(pattern => pattern.test(titleLower));
    });
    
    console.log(`🎯 Filtrate pentru S${season}E${episode}: ${filtered.length} din ${subtitles.length}`);
    return filtered.length > 0 ? filtered : subtitles;
}

// Funcție principală de căutare subtitrări
async function searchSubtitles(imdbId, type, season, episode) {
    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 Cerere nouă: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
        console.log(`⏰ ${new Date().toISOString()}`);
        
        // Pasul 1: Obținem informații despre titlu (opțional, pentru logging)
        const info = await getMediaInfo(imdbId);
        if (info) {
            console.log(`📺 ${info.title} (${info.year})`);
        }
        
        // Pasul 2: Căutăm pe titrari.ro
        let subtitles = await searchByImdbId(imdbId);
        
        // Pasul 3: Pentru seriale, filtrăm după sezon și episod
        if (type === 'series' && season && episode && subtitles.length > 0) {
            subtitles = filterForEpisode(subtitles, season, episode);
        }
        
        console.log(`📊 Rezultat final: ${subtitles.length} subtitrări`);
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
    console.log('📥 CERERE NOUĂ STREMIO');
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
console.log('✅ Addon Titrari.ro PORNIT!');
console.log(`📍 Port: ${port}`);
console.log(`🌐 Manifest: http://localhost:${port}/manifest.json`);
console.log(`📦 Pentru Render.com: https://YOUR-APP.onrender.com/manifest.json`);
console.log('🚀'.repeat(30) + '\n');