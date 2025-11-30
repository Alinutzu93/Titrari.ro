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

// Funcție pentru a extrage ID-ul filmului din URL
function extractMovieId(url) {
    const match = url.match(/id=(\d+)/);
    return match ? match[1] : null;
}

// Funcție pentru a găsi subtitrări pe pagina de rezultate căutare
async function searchByImdbId(imdbId) {
    const cacheKey = `search:${imdbId}`;
    
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log('📦 Cache hit pentru', imdbId);
            return cached.data;
        }
    }
    
    try {
        // Titrari.ro folosește "cautarecutare" pentru căutare cu IMDB
        const cleanImdbId = imdbId.replace('tt', '');
        const searchUrl = `https://titrari.ro/index.php?page=cautarecutare&z7=&z2=&z5=${cleanImdbId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;
        
        console.log(`🔍 Caut: ${imdbId}`);
        console.log(`🔗 URL: ${searchUrl}`);
        
        const response = await axios.get(searchUrl, {
            headers: COMMON_HEADERS,
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const results = [];
        
        // Căutăm toate link-urile către pagini de detalii filme
        // Structura: <a href="index.php?page=movie_details&id=XXXXX">
        $('a[href*="movie_details"]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href) {
                const movieId = extractMovieId(href);
                if (movieId) {
                    // Găsim container-ul pentru a extrage titlul și detaliile
                    const $parent = $(elem).closest('td, div, article');
                    const title = $(elem).text().trim() || $parent.find('strong, b').first().text().trim();
                    
                    results.push({
                        movieId: movieId,
                        title: title,
                        url: `https://titrari.ro/index.php?page=movie_details&id=${movieId}`
                    });
                }
            }
        });
        
        console.log(`✅ Găsite ${results.length} rezultate pentru ${imdbId}`);
        
        if (results.length > 0) {
            cache.set(cacheKey, { data: results, timestamp: Date.now() });
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Eroare la căutare:', error.message);
        return [];
    }
}

// Funcție pentru a extrage subtitrările de pe pagina filmului
async function getSubtitlesFromMovie(movieId, movieUrl, type, season, episode) {
    try {
        console.log(`📄 Accesez: ${movieUrl}`);
        
        const response = await axios.get(movieUrl, {
            headers: COMMON_HEADERS,
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const subtitles = [];
        
        // Extragem titlul filmului/serialului
        const pageTitle = $('h1, h2, h3').first().text().trim() || 'Unknown';
        console.log(`🎬 Film: ${pageTitle}`);
        
        // Căutăm toate link-urile de download
        // Titrari.ro folosește: <a href="get.php?id=XXXXX">
        $('a[href*="get.php"]').each((i, elem) => {
            const $elem = $(elem);
            const downloadLink = $elem.attr('href');
            
            if (downloadLink && downloadLink.includes('get.php?id=')) {
                // Găsim container-ul pentru detalii
                const $container = $elem.closest('tr, div, article, section, td');
                const containerText = $container.text();
                
                // Extragem informații
                let fps = '';
                let translator = '';
                let downloads = '0';
                let releaseInfo = '';
                
                // FPS
                const fpsMatch = containerText.match(/Framerate[:\s]*([0-9.]+)\s*FPS/i);
                if (fpsMatch) fps = fpsMatch[1];
                
                // Traducător
                const translatorMatch = containerText.match(/Traducator[:\s]*([^\n]+?)(?:Uploader|Framerate|Numar|$)/i);
                if (translatorMatch) {
                    translator = translatorMatch[1]
                        .trim()
                        .replace(/\s+/g, ' ')
                        .substring(0, 50); // Limităm lungimea
                }
                
                // Număr descărcări
                const downloadsMatch = containerText.match(/Descarcari[:\s]*(\d+)/i);
                if (downloadsMatch) downloads = downloadsMatch[1];
                
                // Info release (de pe rândul cu titlul)
                const releaseMatch = containerText.match(/([A-Z0-9]+[\w.-]+(?:BluRay|WEB-DL|WEBRip|HDTV|BRRip)[\w.-]+)/i);
                if (releaseMatch) releaseInfo = releaseMatch[1].substring(0, 60);
                
                // Verificăm dacă este pentru episodul corect (pentru seriale)
                let isCorrectEpisode = true;
                if (type === 'series' && season && episode) {
                    const seasonPattern = new RegExp(`S0*${season}[\\s.E-]`, 'i');
                    const episodePattern = new RegExp(`E0*${episode}(?![0-9])`, 'i');
                    const fullPattern = new RegExp(`S0*${season}E0*${episode}`, 'i');
                    
                    const textToCheck = pageTitle + ' ' + releaseInfo + ' ' + containerText;
                    isCorrectEpisode = fullPattern.test(textToCheck) || 
                                      (seasonPattern.test(textToCheck) && episodePattern.test(textToCheck));
                    
                    if (!isCorrectEpisode) {
                        console.log(`⏭️  Skip: nu este S${season}E${episode}`);
                        return; // Skip acest rezultat
                    }
                }
                
                // Construim titlul descriptiv
                let displayTitle = '🇷🇴 Titrari.ro';
                if (releaseInfo) displayTitle += ` - ${releaseInfo}`;
                if (fps) displayTitle += ` [${fps} FPS]`;
                if (translator) displayTitle += ` (${translator})`;
                if (downloads !== '0') displayTitle += ` ↓${downloads}`;
                
                const fullUrl = downloadLink.startsWith('http') 
                    ? downloadLink 
                    : `https://titrari.ro/${downloadLink}`;
                
                subtitles.push({
                    id: `titrari:${movieId}:${i}`,
                    url: fullUrl,
                    lang: 'ron',
                    title: displayTitle,
                    downloads: parseInt(downloads) || 0
                });
                
                console.log(`✅ Găsită: ${displayTitle}`);
            }
        });
        
        // Sortăm după popularitate
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        return subtitles;
        
    } catch (error) {
        console.error('❌ Eroare la accesarea paginii:', error.message);
        return [];
    }
}

// Funcție principală de căutare subtitrări
async function searchSubtitles(imdbId, type, season, episode) {
    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 Cerere: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
        console.log(`⏰ ${new Date().toISOString()}`);
        
        // Pasul 1: Căutăm pe titrari.ro după IMDB ID
        const searchResults = await searchByImdbId(imdbId);
        
        if (searchResults.length === 0) {
            console.log('❌ Nu s-au găsit rezultate');
            console.log('='.repeat(60));
            return [];
        }
        
        // Pasul 2: Extragem subtitrările din fiecare rezultat
        const allSubtitles = [];
        
        // Procesăm primele 3 rezultate (pentru a nu face prea multe cereri)
        const resultsToProcess = searchResults.slice(0, 3);
        
        for (const result of resultsToProcess) {
            console.log(`\n📂 Procesez: ${result.title} (ID: ${result.movieId})`);
            
            const subs = await getSubtitlesFromMovie(
                result.movieId,
                result.url,
                type,
                season,
                episode
            );
            
            allSubtitles.push(...subs);
            
            // Delay mic între cereri pentru a nu suprasolicita serverul
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Sortăm final după popularitate
        allSubtitles.sort((a, b) => b.downloads - a.downloads);
        
        console.log(`\n📊 Total găsite: ${allSubtitles.length} subtitrări`);
        console.log('='.repeat(60));
        
        return allSubtitles;
        
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
console.log('✅ Addon Titrari.ro PORNIT!');
console.log(`📍 Port: ${port}`);
console.log(`🌐 Manifest Local: http://localhost:${port}/manifest.json`);
console.log(`🌐 Pentru Render.com: https://YOUR-APP.onrender.com/manifest.json`);
console.log('🚀'.repeat(30) + '\n');
