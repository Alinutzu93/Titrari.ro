// server.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');

// Definirea manifestului addon-ului
const manifest = {
    id: 'ro.titrari.stremio',
    version: '1.0.6',
    name: 'Titrari.ro',
    description: 'Subtitrari in limba romana de pe titrari.ro',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    logo: 'https://titrari.ro/images/logo.png'
};

console.log('Titrari.ro Addon v1.0.6 LOADED');

const builder = new addonBuilder(manifest);

// Cache pentru a evita apeluri repetate
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 minute

// Headers comune pentru toate request-urile
const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': 'https://titrari.ro/'
};

// Functie pentru a corecta diacriticele gresite
function fixBrokenDiacritics(text) {
    const fixes = {
        '\xAA': 'Ș',
        '\xBA': 'ș',
        '\xDE': 'Ț',
        '\xFE': 'ț'
    };
    
    let fixedText = text;
    for (const [wrong, correct] of Object.entries(fixes)) {
        const regex = new RegExp(wrong, 'g');
        fixedText = fixedText.replace(regex, correct);
    }
    
    return fixedText;
}

// Decoder manual pentru Windows-1250
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
        if (win1250Map[byte]) {
            result += win1250Map[byte];
        } else if (byte >= 0x20 && byte <= 0x7E) {
            result += String.fromCharCode(byte);
        } else if (byte < 0x20) {
            result += String.fromCharCode(byte);
        } else {
            result += String.fromCharCode(byte);
        }
    }
    return result;
}

// Functie pentru a detecta si converti encoding-ul corect
function decodeRomanianText(buffer) {
    let text = decodeWindows1250(buffer);
    text = fixBrokenDiacritics(text);
    
    if (/[șțăîâȘȚĂÎÂ]/.test(text) && !/\uFFFD/.test(text)) {
        console.log('Encoding: windows-1250');
        return text;
    }
    
    try {
        text = buffer.toString('utf8');
        text = fixBrokenDiacritics(text);
        if (/[șțăîâȘȚĂÎÂ]/.test(text) && !/\uFFFD/.test(text)) {
            console.log('Encoding: utf8');
            return text;
        }
    } catch (e) {}
    
    try {
        text = buffer.toString('latin1');
        text = fixBrokenDiacritics(text);
        console.log('Encoding: latin1 fallback');
        return text;
    } catch (e) {}
    
    console.log('Encoding: windows-1250 fallback');
    return fixBrokenDiacritics(decodeWindows1250(buffer));
}

// Functie pentru normalizare text
function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Functie pentru a extrage ID-ul subtitrarii
function extractSubtitleId(href) {
    const match = href.match(/id=(\d+)/);
    return match ? match[1] : null;
}

// Functie pentru a gasi episodul corect in arhiva
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
        new RegExp(`[^0-9]0*${season}0*${episode}[^0-9]`, 'i'),
        new RegExp(`Episode[\\s._-]*0*${episode}`, 'i'),
        new RegExp(`Ep0*${episode}[^0-9]`, 'i'),
        new RegExp(`E0*${episode}[^0-9]`, 'i')
    ];
    
    console.log(`Caut episod S${season}E${episode}`);
    
    for (const fileName of fileNames) {
        const lowerName = fileName.toLowerCase();
        if (!lowerName.endsWith('.srt') && !lowerName.endsWith('.sub')) {
            continue;
        }
        
        for (const pattern of patterns) {
            if (pattern.test(fileName)) {
                console.log(`MATCH: ${fileName}`);
                return fileName;
            }
        }
    }
    
    console.log('Nu s-a gasit episodul exact, folosesc primul .srt');
    return fileNames.find(name => 
        name.toLowerCase().endsWith('.srt') || 
        name.toLowerCase().endsWith('.sub')
    );
}

// Functie pentru a extrage subtitrare din arhiva
async function extractSrtFromArchive(downloadUrl, subId, season = null, episode = null) {
    try {
        console.log(`Descarc: ${downloadUrl}`);
        
        const response = await axios.get(downloadUrl, {
            headers: COMMON_HEADERS,
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        console.log(`Fisier descarcat: ${response.data.length} bytes`);
        
        const buffer = Buffer.from(response.data);
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
        const isRar = buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72;
        
        // ZIP
        if (isZip) {
            console.log('Fisier ZIP detectat');
            try {
                const zip = new AdmZip(buffer);
                const zipEntries = zip.getEntries();
                
                const subtitleFiles = [];
                zipEntries.forEach(entry => {
                    const fileName = entry.entryName.toLowerCase();
                    if (fileName.endsWith('.srt') || fileName.endsWith('.sub')) {
                        subtitleFiles.push(entry.entryName);
                    }
                });
                
                const targetFile = findEpisodeFile(subtitleFiles, season, episode);
                if (!targetFile) {
                    console.log('Nu s-a gasit fisier SRT in ZIP');
                    return null;
                }
                
                const entry = zipEntries.find(e => e.entryName === targetFile);
                if (!entry) return null;
                
                const content = entry.getData();
                return decodeRomanianText(content);
            } catch (zipError) {
                console.error(`Eroare ZIP: ${zipError.message}`);
                return null;
            }
        }
        // RAR
        else if (isRar) {
            console.log('Fisier RAR detectat');
            try {
                const extractor = await createExtractorFromData({ data: buffer });
                const list = extractor.getFileList();
                const fileHeaders = [...list.fileHeaders];
                
                const subtitleFiles = [];
                fileHeaders.forEach(fileHeader => {
                    const fileName = fileHeader.name.toLowerCase();
                    if (fileName.endsWith('.srt') || fileName.endsWith('.sub')) {
                        subtitleFiles.push(fileHeader.name);
                    }
                });
                
                const targetFile = findEpisodeFile(subtitleFiles, season, episode);
                if (!targetFile) {
                    console.log('Nu s-a gasit fisier SRT in RAR');
                    return null;
                }
                
                const extracted = extractor.extract({ files: [targetFile] });
                const files = [...extracted.files];
                
                if (files.length > 0 && files[0].extraction) {
                    const content = files[0].extraction;
                    return decodeRomanianText(Buffer.from(content));
                }
                
                return null;
            } catch (rarError) {
                console.error(`Eroare RAR: ${rarError.message}`);
                return null;
            }
        }
        // Text direct
        else {
            console.log('Fisier text direct');
            return decodeRomanianText(buffer);
        }
    } catch (error) {
        console.error(`Eroare descarcare: ${error.message}`);
        return null;
    }
}

// Functie pentru cautare pe titrari.ro
async function searchByImdbId(imdbId, type, season, episode) {
    const cacheKey = `search:${imdbId}:${season || 'x'}:${episode || 'x'}`;
    
    try {
        const cleanImdbId = imdbId.replace('tt', '');
        const searchUrl = `https://titrari.ro/index.php?page=numaicautamcaneiesepenas&z7=&z2=&z5=${cleanImdbId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;
        
        console.log(`Caut pe titrari.ro: ${imdbId}${season ? ` (S${season}E${episode})` : ''}`);
        
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
        
        console.log(`Gasite ${downloadLinks.length} link-uri de download`);
        
        // Procesam fiecare link
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
            
            // Pentru seriale, verificam sezonul/episodul
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
                    if (!hasSeason) {
                        continue;
                    }
                }
            }
            
            // Extragem detalii
            let fps = '';
            let downloads = '0';
            
            const fpsMatch = allText.match(/Framerate[:\s]*([0-9.]+)\s*FPS/i);
            if (fpsMatch) fps = fpsMatch[1];
            
            const downloadsMatch = allText.match(/Descarcari[:\s]*(\d+)/i);
            if (downloadsMatch) downloads = downloadsMatch[1];
            
            // Pentru seriale, verificam daca arhiva contine episodul
            if (type === 'series' && season && episode) {
                const fullDownloadUrl = downloadLink.startsWith('http') 
                    ? downloadLink 
                    : `https://titrari.ro/${downloadLink}`;
                
                console.log(`Verific daca arhiva contine S${season}E${episode}...`);
                
                // Descarcam si verificam arhiva
                const srtContent = await extractSrtFromArchive(fullDownloadUrl, subId, season, episode);
                
                if (srtContent) {
                    // Cream un URL special care va returna subtitrarea extrasa
                    // Stremio va face request la acest URL
                    subtitles.push({
                        id: `titrari:${subId}:${season}:${episode}`,
                        lang: 'ro',
                        url: fullDownloadUrl,
                        title: title || `Titrari.ro - ${imdbId}`,
                        fps: fps || 'Auto',
                        downloads: parseInt(downloads) || 0
                    });
                    console.log(`Episodul S${season}E${episode} gasit in arhiva!`);
                } else {
                    console.log(`Episodul S${season}E${episode} NU este in arhiva`);
                }
            } else {
                // Pentru filme, adaugam direct
                const fullDownloadUrl = downloadLink.startsWith('http') 
                    ? downloadLink 
                    : `https://titrari.ro/${downloadLink}`;
                
                subtitles.push({
                    id: `titrari:${subId}`,
                    lang: 'ro',
                    url: fullDownloadUrl,
                    title: title || `Titrari.ro - ${imdbId}`,
                    fps: fps || 'Auto',
                    downloads: parseInt(downloads) || 0
                });
            }
        }
        
        console.log(`Returnez ${subtitles.length} subtitrari`);
        
        // Sortam dupa numar de descarcari
        subtitles.sort((a, b) => b.downloads - a.downloads);
        
        // Cache rezultatele
        cache.set(cacheKey, {
            data: subtitles,
            timestamp: Date.now()
        });
        
        return subtitles;
        
    } catch (error) {
        console.error(`Eroare cautare: ${error.message}`);
        return [];
    }
}

// Handler pentru subtitrari
builder.defineSubtitlesHandler(async (args) => {
    const { type, id } = args;
    
    console.log(`Cerere subtitrari: type=${type}, id=${id}`);
    
    try {
        const parts = id.split(':');
        const imdbId = parts[0];
        const season = parts[1] ? parseInt(parts[1]) : null;
        const episode = parts[2] ? parseInt(parts[2]) : null;
        
        const subtitles = await searchByImdbId(imdbId, type, season, episode);
        
        return Promise.resolve({ subtitles });
    } catch (error) {
        console.error('Eroare handler subtitrari:', error);
        return Promise.resolve({ subtitles: [] });
    }
});

// Porneste serverul
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), {
    port: PORT,
    cacheMaxAge: 60 * 60
}).then(() => {
    console.log(`Server pornit pe portul ${PORT}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
}).catch(error => {
    console.error('Eroare pornire server:', error);
    process.exit(1);
});
