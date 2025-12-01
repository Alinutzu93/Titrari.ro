// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');

// Definirea manifestului addon-ului
const manifest = {
    id: 'ro.titrari.stremio',
    version: '1.0.3',
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

// Cache pentru URL-urile originale ale subtitrărilor
const subtitleUrlCache = new Map();

// Funcție pentru a extrage SRT din ZIP
async function extractSrtFromZip(zipUrl, subId) {
    try {
        console.log(`📥 Descarc ZIP: ${zipUrl}`);
        
        // Descărcăm ZIP-ul
        const response = await axios.get(zipUrl, {
            headers: COMMON_HEADERS,
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        console.log(`✅ ZIP descărcat: ${response.data.length} bytes`);
        
        // Extragem conținutul ZIP-ului
        const zip = new AdmZip(response.data);
        const zipEntries = zip.getEntries();
        
        console.log(`📦 Fișiere în ZIP: ${zipEntries.length}`);
        
        // Căutăm fișierul SRT/SUB
        for (const entry of zipEntries) {
            const fileName = entry.entryName.toLowerCase();
            console.log(`   - ${entry.entryName}`);
            
            if (fileName.endsWith('.srt') || fileName.endsWith('.sub')) {
                console.log(`✅ Găsit subtitrare: ${entry.entryName}`);
                const content = entry.getData();
                
                // Convertim la UTF-8 dacă e necesar
                let textContent = content.toString('utf8');
                
                // Dacă conține caractere ciudate, încearcă alte encodings
                if (textContent.includes('�')) {
                    textContent = content.toString('latin1');
                }
                
                return textContent;
            }
        }
        
        console.log('⚠️ Nu s-a găsit fișier SRT în ZIP');
        return null;
        
    } catch (error) {
        console.error(`❌ Eroare extragere SRT: ${error.message}`);
        return null;
    }
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
        
        // Parcurgem toate link-urile de download
        const downloadLinks = [];
        $('a[href*="get.php?id="]').each((i, elem) => {
            const $elem = $(elem);
            const downloadLink = $elem.attr('href');
            const subId = extractSubtitleId(downloadLink);
            
            if (subId) {
                downloadLinks.push({
                    elem: $elem,
                    link: downloadLink,
                    subId: subId
                });
            }
        });
        
        console.log(`📋 Găsite ${downloadLinks.length} link-uri de download`);
        
        // Procesăm fiecare link
        for (const item of downloadLinks) {
            const { elem: $elem, link: downloadLink, subId } = item;
            
            // Găsim rândul părinte (tr) care conține toate detaliile
            const $row = $elem.closest('tr');
            const allText = $row.text();
            
            // Extragem titlul filmului/serialului
            let title = '';
            $row.find('h1 a, .row1 a[style*="color:black"]').each((j, titleElem) => {
                const text = $(titleElem).text().trim();
                if (text && text.length > 3) {
                    title = text;
                }
            });
            
            if (!title) {
                const h1Text = $row.find('h1').text().trim();
                if (h1Text) title = h1Text;
            }
            
            // Extragem detalii
            let fps = '';
            let translator = '';
            let downloads = '0';
            let releaseInfo = '';
            
            const fpsMatch = allText.match(/Framerate[:\s]*([0-9.]+)\s*FPS/i);
            if (fpsMatch) fps = fpsMatch[1];
            
            const translatorMatch = allText.match(/Traducator[:\s]*([^\n\r]+?)(?:Uploader|Framerate|$)/i);
            if (translatorMatch) {
                translator = translatorMatch[1]
                    .trim()
                    .replace(/\s+/g, ' ')
                    .replace(/\[|\]/g, '')
                    .substring(0, 50);
            }
            
            const downloadsMatch = allText.match(/Descarcari[:\s]*(\d+)/i);
            if (downloadsMatch) downloads = downloadsMatch[1];
            
            const commentMatch = allText.match(/Comentariu[:\s]*([^\n]+)/i);
            if (commentMatch) {
                releaseInfo = commentMatch[1].trim().substring(0, 80);
            }
            
            // Pentru seriale, verificăm dacă este episodul corect
            if (type === 'series' && season && episode) {
                const textToCheck = title + ' ' + releaseInfo + ' ' + allText;
                
                const patterns = [
                    new RegExp(`S0*${season}E0*${episode}(?!\\d)`, 'i'),
                    new RegExp(`${season}x0*${episode}`, 'i'),
                    new RegExp(`Sezon[ul\\s]*0*${season}[\\s.,E-]*(?:ep\\.?|episod)[\\s]*0*${episode}`, 'i')
                ];
                
                const matches = patterns.some(p => p.test(textToCheck));
                
                if (!matches) {
                    console.log(`⏭️  Skip: ${title} - nu este S${season}E${episode}`);
                    continue;
                }
            }
            
            // Construim URL-ul complet
            const fullUrl = downloadLink.startsWith('http') 
                ? downloadLink 
                : `https://titrari.ro/${downloadLink}`;
            
            // Folosim direct URL-ul (get.php returnează fișierul direct)
            const directUrl = fullUrl;
            
            console.log(`🔗 URL subtitrare: ${directUrl}`);
            
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
            
            // Cream URL proxy prin serverul nostru pentru a extrage SRT din ZIP
            const proxyUrl = `${process.env.PROXY_URL || 'http://localhost:7000'}/subtitle/${subId}.srt`;
            
            subtitles.push({
                id: `titrari:${subId}`,
                url: proxyUrl, // URL-ul proxy care va extrage SRT-ul
                lang: 'ron',
                title: displayTitle,
                downloads: parseInt(downloads) || 0,
                _originalUrl: directUrl // Păstrăm URL-ul original pentru proxy
            });
            
            console.log(`✅ ${displayTitle}`);
        }
        
        // Sortăm după popularitate
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        // Salvăm URL-urile originale în cache pentru endpoint-ul proxy
        subtitles.forEach(sub => {
            if (sub._originalUrl) {
                subtitleUrlCache.set(sub.id.split(':')[1], sub._originalUrl);
                delete sub._originalUrl; // Ștergem din obiectul returnat
            }
        });
        
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
    
    const imdbId = id.split(':')[0];
    
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

// Cream server HTTP custom pentru a adăuga endpoint-ul /subtitle
const http = require('http');
const url = require('url');

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    // Endpoint pentru descărcare subtitrări
    if (parsedUrl.pathname.startsWith('/subtitle/')) {
        const match = parsedUrl.pathname.match(/\/subtitle\/(\d+)\.srt/);
        
        if (!match) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        
        const subId = match[1];
        const originalUrl = subtitleUrlCache.get(subId);
        
        if (!originalUrl) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Subtitle not found in cache');
            return;
        }
        
        console.log(`\n📥 Request subtitrare: ${subId}`);
        console.log(`🔗 URL original: ${originalUrl}`);
        
        try {
            const srtContent = await extractSrtFromZip(originalUrl, subId);
            
            if (!srtContent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Failed to extract subtitle');
                return;
            }
            
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="subtitle_${subId}.srt"`,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(srtContent);
            
            console.log(`✅ Subtitrare servită: ${srtContent.length} caractere\n`);
            
        } catch (error) {
            console.error(`❌ Eroare servire subtitrare: ${error.message}`);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error serving subtitle');
        }
        
        return;
    }
    
    // Pentru alte cereri, nu facem nimic (le va gestiona Stremio SDK)
});

// Montăm Stremio addon pe server-ul nostru
serveHTTP(builder.getInterface(), { 
    server: server
});

console.log('\n' + '🚀'.repeat(30));
console.log('✅ Addon Titrari.ro v1.0.3 PORNIT!');
console.log(`📍 Port: ${port}`);
console.log(`🌐 Manifest Local: http://localhost:${port}/manifest.json`);
console.log(`🌐 Pentru Render.com: https://YOUR-APP.onrender.com/manifest.json`);
console.log('🚀'.repeat(30) + '\n');
