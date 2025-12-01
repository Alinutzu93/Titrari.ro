// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');

// Definirea manifestului addon-ului
const manifest = {
    id: 'ro.titrari.stremio',
    version: '1.0.7',
    name: 'Titrari.ro',
    description: 'Subtitrari in limba romana de pe titrari.ro',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    logo: 'https://titrari.ro/images/logo.png'
};

console.log('Titrari.ro Addon v1.0.7 LOADED');

const builder = new addonBuilder(manifest);

// Cache
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

// Headers
const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': 'https://titrari.ro/'
};

function fixBrokenDiacritics(text) {
    const fixes = {
        '\xAA': 'Ș', '\xBA': 'ș', '\xDE': 'Ț', '\xFE': 'ț'
    };
    let fixedText = text;
    for (const [wrong, correct] of Object.entries(fixes)) {
        fixedText = fixedText.replace(new RegExp(wrong, 'g'), correct);
    }
    return fixedText;
}

function decodeWindows1250(buffer) {
    const win1250Map = {
        0x8A: 'Ș', 0x9A: 'ș', 0x8C: 'Ț', 0x9C: 'ț',
        0xC3: 'Ă', 0xE3: 'ă', 0xCE: 'Î', 0xEE: 'î',
        0xC2: 'Â', 0xE2: 'â', 0xAA: 'Ș', 0xBA: 'ș',
        0xDE: 'Ț', 0xFE: 'ț'
    };
    
    let result = '';
    for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i];
        result += win1250Map[byte] || String.fromCharCode(byte);
    }
    return result;
}

function decodeRomanianText(buffer) {
    let text = decodeWindows1250(buffer);
    text = fixBrokenDiacritics(text);
    
    if (/[șțăîâȘȚĂÎÂ]/.test(text) && !/\uFFFD/.test(text)) {
        return text;
    }
    
    try {
        text = buffer.toString('utf8');
        text = fixBrokenDiacritics(text);
        if (/[șțăîâȘȚĂÎÂ]/.test(text) && !/\uFFFD/.test(text)) {
            return text;
        }
    } catch (e) {}
    
    return fixBrokenDiacritics(decodeWindows1250(buffer));
}

function extractSubtitleId(href) {
    const match = href.match(/id=(\d+)/);
    return match ? match[1] : null;
}

function findEpisodeFile(fileNames, season, episode) {
    if (!season || !episode) {
        return fileNames.find(name => 
            name.toLowerCase().endsWith('.srt') || 
            name.toLowerCase().endsWith('.sub')
        );
    }
    
    const patterns = [
        new RegExp(`S0*${season}E0*${episode}[^0-9]`, 'i'),
        new RegExp(`${season}x0*${episode}[^0-9]`, 'i'),
        new RegExp(`S0*${season}\\.E0*${episode}`, 'i'),
        new RegExp(`Episode[\\s._-]*0*${episode}`, 'i'),
        new RegExp(`Ep0*${episode}[^0-9]`, 'i'),
        new RegExp(`E0*${episode}[^0-9]`, 'i')
    ];
    
    console.log(`Caut episod S${season}E${episode}`);
    
    for (const fileName of fileNames) {
        const lowerName = fileName.toLowerCase();
        if (!lowerName.endsWith('.srt') && !lowerName.endsWith('.sub')) continue;
        
        for (const pattern of patterns) {
            if (pattern.test(fileName)) {
                console.log(`MATCH: ${fileName}`);
                return fileName;
            }
        }
    }
    
    console.log('Folosesc primul .srt gasit');
    return fileNames.find(name => 
        name.toLowerCase().endsWith('.srt') || 
        name.toLowerCase().endsWith('.sub')
    );
}

async function extractSrtFromArchive(downloadUrl, subId, season = null, episode = null) {
    try {
        console.log(`Descarc: ${downloadUrl}`);
        
        const response = await axios.get(downloadUrl, {
            headers: COMMON_HEADERS,
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        const buffer = Buffer.from(response.data);
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
        const isRar = buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72;
        
        if (isZip) {
            console.log('ZIP detectat');
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries();
            
            const subtitleFiles = zipEntries
                .filter(e => e.entryName.toLowerCase().endsWith('.srt') || e.entryName.toLowerCase().endsWith('.sub'))
                .map(e => e.entryName);
            
            const targetFile = findEpisodeFile(subtitleFiles, season, episode);
            if (!targetFile) return null;
            
            const entry = zipEntries.find(e => e.entryName === targetFile);
            if (!entry) return null;
            
            return decodeRomanianText(entry.getData());
        }
        else if (isRar) {
            console.log('RAR detectat');
            const extractor = await createExtractorFromData({ data: buffer });
            const list = extractor.getFileList();
            const fileHeaders = [...list.fileHeaders];
            
            const subtitleFiles = fileHeaders
                .filter(f => f.name.toLowerCase().endsWith('.srt') || f.name.toLowerCase().endsWith('.sub'))
                .map(f => f.name);
            
            const targetFile = findEpisodeFile(subtitleFiles, season, episode);
            if (!targetFile) return null;
            
            const extracted = extractor.extract({ files: [targetFile] });
            const files = [...extracted.files];
            
            if (files.length > 0 && files[0].extraction) {
                return decodeRomanianText(Buffer.from(files[0].extraction));
            }
            return null;
        }
        else {
            console.log('Text direct');
            return decodeRomanianText(buffer);
        }
    } catch (error) {
        console.error(`Eroare: ${error.message}`);
        return null;
    }
}

async function searchByImdbId(imdbId, type, season, episode) {
    try {
        const cleanImdbId = imdbId.replace('tt', '');
        const searchUrl = `https://titrari.ro/index.php?page=numaicautamcaneiesepenas&z7=&z2=&z5=${cleanImdbId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;
        
        console.log(`Caut: ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
        
        const response = await axios.get(searchUrl, {
            headers: COMMON_HEADERS,
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const subtitles = [];
        
        $('a[href*="get.php?id="]').each((i, elem) => {
            const $elem = $(elem);
            const downloadLink = $elem.attr('href');
            const subId = extractSubtitleId(downloadLink);
            
            if (!subId) return;
            
            const $row = $elem.closest('tr');
            const allText = $row.text();
            
            let title = '';
            $row.find('h1 a, .row1 a[style*="color:black"]').each((j, titleElem) => {
                const text = $(titleElem).text().trim();
                if (text && text.length > 3) title = text;
            });
            
            if (!title) {
                const h1Text = $row.find('h1').text().trim();
                if (h1Text) title = h1Text;
            }
            
            // Pentru seriale
            if (type === 'series' && season && episode) {
                const textToCheck = title + ' ' + allText;
                
                const exactEpisodePatterns = [
                    new RegExp(`S0*${season}E0*${episode}(?!\\d)`, 'i'),
                    new RegExp(`S0*${season}\\.E0*${episode}`, 'i'),
                    new RegExp(`${season}x0*${episode}(?!\\d)`, 'i')
                ];
                
                const hasExactEpisode = exactEpisodePatterns.some(p => p.test(textToCheck));
                
                if (!hasExactEpisode) {
                    const seasonPatterns = [
                        new RegExp(`Sezon[ul\\s]*0*${season}(?![0-9])`, 'i'),
                        new RegExp(`Season[\\s]*0*${season}(?![0-9])`, 'i'),
                        new RegExp(`S0*${season}(?![0-9E])`, 'i')
                    ];
                    
                    const hasSeason = seasonPatterns.some(p => p.test(textToCheck));
                    if (!hasSeason) return;
                }
            }
            
            let fps = '';
            let downloads = '0';
            
            const fpsMatch = allText.match(/Framerate[:\s]*([0-9.]+)\s*FPS/i);
            if (fpsMatch) fps = fpsMatch[1];
            
            const downloadsMatch = allText.match(/Descarcari[:\s]*(\d+)/i);
            if (downloadsMatch) downloads = downloadsMatch[1];
            
            const fullDownloadUrl = downloadLink.startsWith('http') 
                ? downloadLink 
                : `https://titrari.ro/${downloadLink}`;
            
            subtitles.push({
                id: `titrari:${subId}`,
                subId: subId,
                lang: 'ro',
                url: fullDownloadUrl,
                title: title || `Titrari.ro - ${imdbId}`,
                fps: fps || 'Auto',
                downloads: parseInt(downloads) || 0
            });
        });
        
        console.log(`Gasit: ${subtitles.length} subtitrari`);
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        return subtitles;
        
    } catch (error) {
        console.error(`Eroare cautare: ${error.message}`);
        return [];
    }
}

// Handler pentru subtitrari - DEFINIT O SINGURA DATA
builder.defineSubtitlesHandler(async (args) => {
    const { type, id } = args;
    
    console.log(`Cerere: type=${type}, id=${id}`);
    
    try {
        const parts = id.split(':');
        const imdbId = parts[0];
        const season = parts[1] ? parseInt(parts[1]) : null;
        const episode = parts[2] ? parseInt(parts[2]) : null;
        
        const subtitles = await searchByImdbId(imdbId, type, season, episode);
        
        // Modificam URL-urile pentru proxy
        const PORT = process.env.PORT || 7000;
        const baseUrl = `https://titrari-ro.onrender.com`;
        
        const modifiedSubtitles = subtitles.map(sub => ({
            ...sub,
            url: `${baseUrl}/subtitle/${sub.subId}/${season || 0}/${episode || 0}.srt`
        }));
        
        return Promise.resolve({ subtitles: modifiedSubtitles });
    } catch (error) {
        console.error('Eroare handler:', error);
        return Promise.resolve({ subtitles: [] });
    }
});

// Server
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT }).then((server) => {
    console.log(`Server pe portul ${PORT}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
    
    // Adaugam proxy pentru subtitrari
    const originalListeners = server.listeners('request').slice(0);
    server.removeAllListeners('request');
    
    server.on('request', async (req, res) => {
        const urlParts = req.url.split('/');
        
        if (urlParts[1] === 'subtitle') {
            const subId = urlParts[2];
            const season = parseInt(urlParts[3]) || null;
            const episode = parseInt(urlParts[4]?.replace('.srt', '')) || null;
            
            console.log(`Proxy: subId=${subId}, S${season}E${episode}`);
            
            try {
                const downloadUrl = `https://titrari.ro/get.php?id=${subId}`;
                const srtContent = await extractSrtFromArchive(downloadUrl, subId, season, episode);
                
                if (srtContent) {
                    res.writeHead(200, {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(srtContent);
                    console.log(`Servit: ${srtContent.length} caractere`);
                } else {
                    res.writeHead(404);
                    res.end('Subtitrare negasita');
                }
            } catch (error) {
                console.error(`Eroare proxy: ${error.message}`);
                res.writeHead(500);
                res.end('Eroare');
            }
        } else {
            for (const listener of originalListeners) {
                listener.call(server, req, res);
            }
        }
    });
}).catch(error => {
    console.error('Eroare start:', error);
    process.exit(1);
});
