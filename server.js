// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const http = require('http');
const url = require('url');

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

// Cache pentru URL-urile originale ale subtitrărilor
const subtitleUrlCache = new Map();

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

// Funcție pentru a extrage SRT din ZIP
async function extractSrtFromZip(zipUrl, subId) {
    try {
        console.log(`📥 Descarc ZIP: ${zipUrl}`);
        
        const response = await axios.get(zipUrl, {
            headers: COMMON_HEADERS,
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        console.log(`✅ ZIP descărcat: ${response.data.length} bytes`);
        
        const zip = new AdmZip(response.data);
        const zipEntries = zip.getEntries();
        
        console.log(`📦 Fișiere în ZIP: ${zipEntries.length}`);
        
        for (const entry of zipEntries) {
            const fileName = entry.entryName.toLowerCase();
            console.log(`   - ${entry.entryName}`);
            
            if (fileName.endsWith('.srt') || fileName.endsWith('.sub')) {
                console.log(`✅ Găsit subtitrare: ${entry.entryName}`);
                const content = entry.getData();
                
                let textContent = content.toString('utf8');
                
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
        
        // Obținem base URL-ul serverului
        const port = process.env.PORT || 7000;
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
        
        for (const item of downloadLinks) {
            const { elem: $elem, link: downloadLink, subId } = item;
            
            const $row = $elem.closest('tr');
            const allText = $row.text();
            
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
            
            if (type === 'series' && season && episode) {
                const textToCheck = title + ' ' + releaseInfo + ' ' + allText;
                
                const patterns = [
                    new RegExp(`S0*${season}E0*${episode}(?!\\d)`, 'i'),
                    new RegExp(`${season}x0*${episode}`, 'i'),
                    new RegExp(`Sezon[ul\\s]*0*${season}[\\s.,E-]*(?:ep\\.?|episod)[\\s]*0*${episode}`, 'i')
                ];
                
                const matches = patterns.some(p => p.test(textToCheck));
                
                if (!matches) {
                    console.log(`⏭️ Skip: ${title} - nu este S${season}E${episode}`);
                    continue;
                }
            }
            
            const fullUrl = downloadLink.startsWith('http') 
                ? downloadLink 
                : `https://titrari.ro/${downloadLink}`;
            
            const directUrl = fullUrl;
            
            console.log(`🔗 URL subtitrare: ${directUrl}`);
            
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
            
            const proxyUrl = `${baseUrl}/subtitle/${subId}.srt`;
            
            subtitles.push({
                id: `titrari:${subId}`,
                url: proxyUrl,
                lang: 'ron',
                title: displayTitle,
                downloads: parseInt(downloads) || 0,
                _originalUrl: directUrl
            });
            
            console.log(`✅ ${displayTitle}`);
        }
        
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        subtitles.forEach(sub => {
            if (sub._originalUrl) {
                subtitleUrlCache.set(sub.id.split(':')[1], sub._originalUrl);
                delete sub._originalUrl;
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
    console.log('🔥 CERERE STREMIO');
    console.log('🔥 Args:', JSON.stringify(args, null, 2));
    
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

// Creăm interfața addon-ului ÎNAINTE de server
const addonInterface = builder.getInterface();

// Creăm server HTTP custom
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    console.log(`📍 Request: ${req.method} ${req.url}`);
    
    // Health check simplu pentru root
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            addon: 'Titrari.ro',
            version: '1.0.3',
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
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
    
    // Pentru /manifest.json, returnăm manifestul direct
    if (parsedUrl.pathname === '/manifest.json') {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end(JSON.stringify(addonInterface.manifest));
        return;
    }
    
    // Pentru cereri de subtitrări de la Stremio
    if (parsedUrl.pathname.startsWith('/subtitles/')) {
        console.log('🎬 Cerere subtitrări Stremio:', parsedUrl.pathname);
        
        // Extragem parametrii din URL
        // Format: /subtitles/movie/tt1375666/...json
        const pathParts = parsedUrl.pathname.split('/');
        const type = pathParts[2]; // movie sau series
        const id = pathParts[3]; // tt1375666 sau tt1375666:1:1
        
        console.log('📝 Type:', type, 'ID:', id);
        
        try {
            const result = await addonInterface.get({ 
                resource: 'subtitles',
                type: type,
                id: id
            });
            
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(result));
            console.log('✅ Răspuns trimis:', result.subtitles?.length || 0, 'subtitrări');
        } catch (error) {
            console.error('❌ Eroare procesare cerere Stremio:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ subtitles: [] }));
        }
        return;
    }
    
    // Pentru ruta root, arătăm info despre addon
    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Titrari.ro Stremio Addon</title>
                <style>
                    body { font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px; }
                    h1 { color: #8A2BE2; }
                    .install-btn { 
                        background: #8A2BE2; 
                        color: white; 
                        padding: 15px 30px; 
                        border: none; 
                        border-radius: 5px; 
                        font-size: 16px;
                        cursor: pointer;
                        text-decoration: none;
                        display: inline-block;
                    }
                    .install-btn:hover { background: #7B1FA2; }
                    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
                </style>
            </head>
            <body>
                <h1>🇷🇴 Titrari.ro - Stremio Addon</h1>
                <p>Addon pentru subtitrări românești de pe <strong>titrari.ro</strong></p>
                <p><strong>Versiune:</strong> ${manifest.version}</p>
                
                <h2>📦 Instalare:</h2>
                <p>Click pe butonul de mai jos pentru a instala addon-ul în Stremio:</p>
                <a href="stremio://${req.headers.host}/manifest.json" class="install-btn">
                    Instalează în Stremio
                </a>
                
                <h2>🔗 Link-uri utile:</h2>
                <ul>
                    <li><a href="/manifest.json">Manifest JSON</a></li>
                    <li><a href="/health">Health Check</a></li>
                </ul>
                
                <h2>📝 Instalare manuală:</h2>
                <p>Copiază acest URL în Stremio:</p>
                <code>https://${req.headers.host}/manifest.json</code>
            </body>
            </html>
        `);
        return;
    }
    
    // Pentru favicon - ignorăm
    if (parsedUrl.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // Pentru OPTIONS (CORS preflight)
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }
    
    // Pentru alte rute necunoscute
    console.log('⚠️ Rută necunoscută:', parsedUrl.pathname);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

// Pornim serverul
const port = process.env.PORT || 7000;

server.listen(port, '0.0.0.0', () => {
    console.log('\n' + '🚀'.repeat(30));
    console.log('✅ Addon Titrari.ro v1.0.3 PORNIT!');
    console.log(`🔌 Port: ${port}`);
    console.log(`🌐 Manifest Local: http://localhost:${port}/manifest.json`);
    console.log(`🌐 Health Check: http://localhost:${port}/health`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`🌍 Public URL: ${process.env.RENDER_EXTERNAL_URL}/manifest.json`);
    }
    console.log('🚀'.repeat(30) + '\n');
}).on('error', (err) => {
    console.error('❌ Eroare la pornirea serverului:', err);
    process.exit(1);
});
