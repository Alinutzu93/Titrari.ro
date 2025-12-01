// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
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

// Funcție pentru a detecta și converti encoding-ul corect pentru română
function decodeRomanianText(buffer) {
    // Încercăm mai multe encoding-uri specifice limbii române
    const encodings = [
        'utf8',           // UTF-8 (modern)
        'latin1',         // ISO-8859-1 
        'windows-1250',   // Windows Central European (cel mai comun pentru .ro)
        'iso-8859-2',     // ISO Latin-2
    ];
    
    for (const encoding of encodings) {
        try {
            let text;
            if (encoding === 'windows-1250' || encoding === 'iso-8859-2') {
                // Pentru Windows-1250 și ISO-8859-2, folosim un decoder manual
                text = decodeWindows1250(buffer);
            } else {
                text = buffer.toString(encoding);
            }
            
            // Verificăm dacă conține caractere românești corecte
            const hasRomanianChars = /[șțăîâȘȚĂÎÂ]/.test(text);
            const hasReplacementChars = /�|�/.test(text);
            
            // Dacă găsim caractere românești și nu avem caractere de replacement, e bun
            if (hasRomanianChars && !hasReplacementChars) {
                console.log(`✅ Encoding detectat: ${encoding}`);
                return text;
            }
            
            // Dacă nu are caractere de replacement, poate fi valid (chiar dacă nu are diacritice)
            if (!hasReplacementChars && text.length > 100) {
                console.log(`✅ Encoding folosit: ${encoding} (fără diacritice detectate)`);
                return text;
            }
        } catch (e) {
            continue;
        }
    }
    
    // Dacă nimic nu merge, folosim UTF-8 ca fallback
    console.log('⚠️ Folosesc UTF-8 ca fallback');
    return buffer.toString('utf8');
}

// Decoder manual pentru Windows-1250
function decodeWindows1250(buffer) {
    // Mapare Windows-1250 pentru caracterele românești
    const win1250Map = {
        0x8A: 'Ș', 0x9A: 'ș',  // Ș ș
        0x8C: 'Ț', 0x9C: 'ț',  // Ț ț  
        0xC3: 'Ă', 0xE3: 'ă',  // Ă ă
        0xCE: 'Î', 0xEE: 'î',  // Î î
        0xC2: 'Â', 0xE2: 'â',  // Â â
    };
    
    let result = '';
    for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i];
        if (win1250Map[byte]) {
            result += win1250Map[byte];
        } else if (byte < 128) {
            result += String.fromCharCode(byte);
        } else {
            // Pentru alte caractere extinse, folosim maparea standard Windows-1250
            result += String.fromCharCode(byte);
        }
    }
    return result;
}

// Funcție pentru a extrage ID-ul subtitrării din link
function extractSubtitleId(href) {
    const match = href.match(/id=(\d+)/);
    return match ? match[1] : null;
}

// Funcție pentru normalizare text (după decodare)
function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Funcție pentru a găsi episodul corect în arhivă (pentru seriale)
function findEpisodeFile(fileNames, season, episode) {
    if (!season || !episode) {
        // Dacă nu e serial, returnăm primul fișier găsit
        return fileNames.find(name => 
            name.toLowerCase().endsWith('.srt') || 
            name.toLowerCase().endsWith('.sub')
        );
    }
    
    // Pattern-uri pentru a detecta episodul corect
    const patterns = [
        new RegExp(`S0*${season}E0*${episode}[^0-9]`, 'i'),  // S01E05
        new RegExp(`${season}x0*${episode}[^0-9]`, 'i'),     // 1x05
        new RegExp(`S0*${season}\\.E0*${episode}`, 'i'),     // S01.E05
        new RegExp(`[^0-9]0*${season}0*${episode}[^0-9]`, 'i'), // 105 (dacă e single digit season)
        new RegExp(`Episode[\\s._-]*0*${episode}`, 'i'),     // Episode 05
        new RegExp(`Ep0*${episode}[^0-9]`, 'i'),             // Ep05
        new RegExp(`E0*${episode}[^0-9]`, 'i'),              // E05
    ];
    
    console.log(`🔍 Caut episod S${season}E${episode} în ${fileNames.length} fișiere`);
    
    // Căutăm fișierul care se potrivește
    for (const fileName of fileNames) {
        const lowerName = fileName.toLowerCase();
        
        // Verificăm dacă e fișier de subtitrare
        if (!lowerName.endsWith('.srt') && !lowerName.endsWith('.sub')) {
            continue;
        }
        
        console.log(`   Verific: ${fileName}`);
        
        // Verificăm pattern-urile
        for (const pattern of patterns) {
            if (pattern.test(fileName)) {
                console.log(`   ✅ MATCH: ${fileName}`);
                return fileName;
            }
        }
    }
    
    console.log(`   ⚠️ Nu s-a găsit episodul exact, folosesc primul .srt găsit`);
    // Dacă nu găsim match exact, returnăm primul .srt
    return fileNames.find(name => 
        name.toLowerCase().endsWith('.srt') || 
        name.toLowerCase().endsWith('.sub')
    );
}

// Funcție pentru a extrage/descărca subtitrare (ZIP, RAR sau direct SRT/SUB)
async function extractSrtFromArchive(downloadUrl, subId, season = null, episode = null) {
    try {
        console.log(`📥 Descarc subtitrare: ${downloadUrl}`);
        
        const response = await axios.get(downloadUrl, {
            headers: COMMON_HEADERS,
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        console.log(`✅ Fișier descărcat: ${response.data.length} bytes`);
        
        const contentType = response.headers['content-type'] || '';
        console.log(`📄 Content-Type: ${contentType}`);
        
        const buffer = Buffer.from(response.data);
        
        // Detectăm tipul de fișier după signature
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B; // PK
        const isRar = buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72; // Rar!
        
        // ZIP
        if (isZip) {
            console.log('📦 Fișier ZIP detectat - extrag conținutul...');
            
            try {
                const zip = new AdmZip(buffer);
                const zipEntries = zip.getEntries();
                
                console.log(`📦 Fișiere în ZIP: ${zipEntries.length}`);
                
                // Colectăm toate fișierele .srt și .sub
                const subtitleFiles = [];
                zipEntries.forEach(entry => {
                    const fileName = entry.entryName.toLowerCase();
                    console.log(`   - ${entry.entryName}`);
                    
                    if (fileName.endsWith('.srt') || fileName.endsWith('.sub')) {
                        subtitleFiles.push(entry.entryName);
                    }
                });
                
                console.log(`📄 Găsite ${subtitleFiles.length} fișiere de subtitrări`);
                
                // Găsim fișierul corect pentru episod
                const targetFile = findEpisodeFile(subtitleFiles, season, episode);
                
                if (!targetFile) {
                    console.log('⚠️ Nu s-a găsit fișier SRT în ZIP');
                    return null;
                }
                
                console.log(`✅ Folosesc: ${targetFile}`);
                
                // Extragem fișierul specific
                const entry = zipEntries.find(e => e.entryName === targetFile);
                if (!entry) {
                    console.log('❌ Eroare: fișierul nu mai există în arhivă');
                    return null;
                }
                
                const content = entry.getData();
                const textContent = decodeRomanianText(content);
                
                return textContent;
                
            } catch (zipError) {
                console.error(`❌ Eroare extragere ZIP: ${zipError.message}`);
                return null;
            }
        } 
        // RAR
        else if (isRar) {
            console.log('📦 Fișier RAR detectat - extrag conținutul...');
            
            try {
                const extractor = await createExtractorFromData({ data: buffer });
                const list = extractor.getFileList();
                const fileHeaders = [...list.fileHeaders];
                
                console.log(`📦 Fișiere în RAR: ${fileHeaders.length}`);
                
                // Colectăm toate fișierele .srt și .sub
                const subtitleFiles = [];
                fileHeaders.forEach(fileHeader => {
                    const fileName = fileHeader.name.toLowerCase();
                    console.log(`   - ${fileHeader.name}`);
                    
                    if (fileName.endsWith('.srt') || fileName.endsWith('.sub')) {
                        subtitleFiles.push(fileHeader.name);
                    }
                });
                
                console.log(`📄 Găsite ${subtitleFiles.length} fișiere de subtitrări`);
                
                // Găsim fișierul corect pentru episod
                const targetFile = findEpisodeFile(subtitleFiles, season, episode);
                
                if (!targetFile) {
                    console.log('⚠️ Nu s-a găsit fișier SRT în RAR');
                    return null;
                }
                
                console.log(`✅ Folosesc: ${targetFile}`);
                
                // Extragem fișierul specific
                const extracted = extractor.extract({ files: [targetFile] });
                const files = [...extracted.files];
                
                if (files.length > 0 && files[0].extraction) {
                    const content = files[0].extraction;
                    const textContent = decodeRomanianText(Buffer.from(content));
                    
                    return textContent;
                }
                
                console.log('⚠️ Nu s-a putut extrage fișierul din RAR');
                return null;
                
            } catch (rarError) {
                console.error(`❌ Eroare extragere RAR: ${rarError.message}`);
                return null;
            }
        } 
        // Text direct (SRT/SUB)
        else {
            console.log('📄 Fișier text direct (SRT/SUB) - nu e arhivă');
            
            // Folosim funcția de decodare inteligentă
            const textContent = decodeRomanianText(buffer);
            
            if (/^\d+\s*\n/.test(textContent) || textContent.includes('-->')) {
                console.log(`✅ Subtitrare validă (${textContent.length} caractere)`);
                return textContent;
            } else {
                console.log('⚠️ Conținutul nu arată ca o subtitrare validă');
                console.log('Primele 200 caractere:', textContent.substring(0, 200));
                return textContent;
            }
        }
        
    } catch (error) {
        console.error(`❌ Eroare descărcare subtitrare: ${error.message}`);
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
        // imdbId vine deja curat (fără :season:episode) din handler-ul HTTP
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
        // Format poate fi: /subtitle/12345.srt sau /subtitle/12345:1:5.srt (cu season:episode)
        const match = parsedUrl.pathname.match(/\/subtitle\/(\d+)(?::(\d+):(\d+))?\.srt/);
        
        if (!match) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        
        const subId = match[1];
        const season = match[2] || null;  // Poate fi undefined pentru filme
        const episode = match[3] || null;
        
        const originalUrl = subtitleUrlCache.get(subId);
        
        if (!originalUrl) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Subtitle not found in cache');
            return;
        }
        
        console.log(`\n📥 Request subtitrare: ${subId}${season ? ` S${season}E${episode}` : ''}`);
        console.log(`🔗 URL original: ${originalUrl}`);
        
        try {
            const srtContent = await extractSrtFromArchive(originalUrl, subId, season, episode);
            
            if (!srtContent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Failed to extract subtitle');
                return;
            }
            
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="subtitle_${subId}${season ? `_S${season}E${episode}` : ''}.srt"`,
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
        // Format: /subtitles/movie/tt1375666/filename=...json
        const pathParts = parsedUrl.pathname.split('/');
        const type = pathParts[2]; // movie sau series
        const idPart = pathParts[3]; // tt1375666 sau tt1375666:1:1 + alte params
        
        // IMPORTANT: Decodăm URL-ul (%3A devine :)
        const decodedIdPart = decodeURIComponent(idPart);
        
        // Extragem doar ID-ul IMDB (fără parametrii extra și fără :season:episode)
        const fullId = decodedIdPart.split(/[?&]/)[0]; // ia doar partea până la ? sau &
        
        // CRITICAL: Separam IMDB ID de season/episode
        const idParts = fullId.split(':');
        const imdbId = idParts[0]; // tt1375666
        let season = null;
        let episode = null;
        
        if (type === 'series' && idParts.length >= 3) {
            season = idParts[1];
            episode = idParts[2];
        }
        
        console.log('📝 Type:', type);
        console.log('📝 Full ID (decoded):', fullId);
        console.log('📝 IMDB ID (clean):', imdbId);
        if (season) console.log('📝 Season:', season, 'Episode:', episode);
        
        try {
            console.log('🔍 Apel searchSubtitles cu:', imdbId, season ? `S${season}E${episode}` : '');
            
            const subtitles = await searchSubtitles(imdbId, type, season, episode);
            
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end(JSON.stringify({ subtitles }));
            console.log('✅ Răspuns trimis:', subtitles.length, 'subtitrări');
        } catch (error) {
            console.error('❌ Eroare procesare cerere Stremio:', error);
            res.writeHead(500, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
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
                
                <hr style="margin: 40px 0; border: none; border-top: 1px solid #ddd;">
                <p style="text-align: center; color: #8A2BE2; font-style: italic; font-size: 18px;">
                    <strong>Ți-am zis că reușesc, așa-i? :D</strong>
                </p>
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
