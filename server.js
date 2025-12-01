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
    version: '1.0.6',
    name: 'Titrari.ro',
    description: 'Subtitrări în limba română de pe titrari.ro - cel mai mare site de subtitrări românești',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    logo: 'https://titrari.ro/images/logo.png'
};

console.log('🚀🚀🚀 Titrari.ro Addon v1.0.6 LOADED - ARCHIVE EPISODE DETECTION 🚀🚀🚀');

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

// Funcție pentru a corecta diacriticele greșite din subtitrări vechi
function fixBrokenDiacritics(text) {
    // Mapare pentru diacritice greșite → corecte
    const fixes = {
        // Ș și ș greșite
        'ª': 'Ș',  // Ș greșit (feminine ordinal indicator)
        'º': 'ș',  // ș greșit (masculine ordinal indicator)
        'Þ': 'Ț',  // Ț greșit (Thorn)
        'þ': 'ț',  // ț greșit (thorn)
        
        // Alte variante greșite comune
        'È™': 'ș',  // ș cu encoding dublu greșit
        'Èš': 'ț',  // ț cu encoding dublu greșit
        'Ã¢': 'â',  // â greșit
        'Ã®': 'î',  // î greșit
        'Äƒ': 'ă',  // ă greșit
        'È›': 'ț',  // ț greșit (alt encoding)
        'È™': 'ș',  // ș greșit (alt encoding)
        
        // Pentru cazul când sunt în UTF-8 greșit
        'Å£': 'ț',
        'Å¡': 'ș',
        'Ã£': 'ă',
        
        // Variante cu sedilă (vechi, dar încă folosite greșit)
        'Ş': 'Ș',  // Ș cu sedilă → Ș cu virgulă
        'ş': 'ș',  // ș cu sedilă → ș cu virgulă
        'Ţ': 'Ț',  // Ț cu sedilă → Ț cu virgulă
        'ţ': 'ț',  // ț cu sedilă → ț cu virgulă
        
        // Alte caractere problematice
        'ã': 'ă',  // ã în loc de ă
        'Ã': 'Ă',  // Ã în loc de Ă
        
        // Fix pentru ghilimele și alte caractere speciale greșite
        'â€œ': '"',
        'â€': '"',
        'â€™': ''',
        'â€"': '–',
        'â€"': '—',
        'â€¦': '…',
    };
    
    let fixedText = text;
    
    // Aplicăm toate corectările
    for (const [wrong, correct] of Object.entries(fixes)) {
        const regex = new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        fixedText = fixedText.replace(regex, correct);
    }
    
    // Fix-uri specifice pentru pattern-uri
    fixedText = fixedText
        // ã → ă când e urmat de consoane (pãrþi → părți)
        .replace(/([cpdt])ã([a-z])/gi, '$1ă$2')
        // þ → ț în contexte normale
        .replace(/þi/g, 'ți')
        .replace(/aþ/g, 'ț')
        // º → ș
        .replace(/º/g, 'ș')
        // ª → Ș
        .replace(/ª/g, 'Ș');
    
    return fixedText;
}

// Decoder manual pentru Windows-1250 (complet)
function decodeWindows1250(buffer) {
    // Mapare completă Windows-1250 pentru toate caracterele speciale
    const win1250Map = {
        // Caractere românești
        0x8A: 'Ș', 0x9A: 'ș',  // Ș ș (Virgulă jos)
        0x8C: 'Ț', 0x9C: 'ț',  // Ț ț (Virgulă jos)
        0xC3: 'Ă', 0xE3: 'ă',  // Ă ă
        0xCE: 'Î', 0xEE: 'î',  // Î î
        0xC2: 'Â', 0xE2: 'â',  // Â â
        
        // Variante cu sedilă (mai vechi, dar încă folosite)
        0xAA: 'Ș', 0xBA: 'ș',  // Ș ș (varianta cu sedilă S cu sedilă)
        0xDE: 'Ț', 0xFE: 'ț',  // Ț ț (varianta cu sedilă T cu sedilă)
        
        // Alte caractere europene comune
        0x8D: 'Ť', 0x9D: 'ť',
        0x8E: 'Ž', 0x9E: 'ž',
        0x8F: 'Ź', 0x9F: 'ź',
        0xA5: 'Ą', 0xB9: 'ą',
        0xAF: 'Ż', 0xBF: 'ż',
        0xC0: 'Ŕ', 0xE0: 'ŕ',
        0xC5: 'Ĺ', 0xE5: 'ĺ',
        0xC6: 'Ć', 0xE6: 'ć',
        0xC8: 'Č', 0xE8: 'č',
        0xCA: 'Ę', 0xEA: 'ę',
        0xCC: 'Ě', 0xEC: 'ě',
        0xCF: 'Ď', 0xEF: 'ď',
        0xD0: 'Đ', 0xF0: 'đ',
        0xD1: 'Ń', 0xF1: 'ń',
        0xD2: 'Ň', 0xF2: 'ň',
        0xD5: 'Ő', 0xF5: 'ő',
        0xD8: 'Ř', 0xF8: 'ř',
        0xD9: 'Ů', 0xF9: 'ů',
        0xDB: 'Ű', 0xFB: 'ű',
        0xDD: 'Ý', 0xFD: 'ý',
    };
    
    let result = '';
    for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i];
        
        if (win1250Map[byte]) {
            result += win1250Map[byte];
        } else if (byte >= 0x20 && byte <= 0x7E) {
            // ASCII standard (32-126)
            result += String.fromCharCode(byte);
        } else if (byte < 0x20) {
            // Control characters (newline, tab, etc.)
            result += String.fromCharCode(byte);
        } else {
            // Pentru alte caractere, folosim maparea standard Latin-1
            const specialChars = {
                0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…',
                0x86: '†', 0x87: '‡', 0x89: '‰', 0x8B: '‹',
                0x91: ''', 0x92: ''', 0x93: '"', 0x94: '"',
                0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™',
                0x9B: '›', 0xA0: ' ', 0xA4: '¤', 0xA6: '¦',
                0xA7: '§', 0xA8: '¨', 0xA9: '©', 0xAB: '«',
                0xAC: '¬', 0xAD: '­', 0xAE: '®', 0xB0: '°',
                0xB1: '±', 0xB2: '²', 0xB3: '³', 0xB4: '´',
                0xB5: 'µ', 0xB6: '¶', 0xB7: '·', 0xB8: '¸',
                0xBB: '»', 0xC1: 'Á', 0xC4: 'Ä', 0xC7: 'Ç',
                0xC9: 'É', 0xCB: 'Ë', 0xCD: 'Í', 0xD3: 'Ó',
                0xD4: 'Ô', 0xD6: 'Ö', 0xD7: '×', 0xDA: 'Ú',
                0xDC: 'Ü', 0xDF: 'ß', 0xE1: 'á', 0xE4: 'ä',
                0xE7: 'ç', 0xE9: 'é', 0xEB: 'ë', 0xED: 'í',
                0xF3: 'ó', 0xF4: 'ô', 0xF6: 'ö', 0xF7: '÷',
                0xFA: 'ú', 0xFC: 'ü', 0xFF: '˙',
            };
            
            result += specialChars[byte] || String.fromCharCode(byte);
        }
    }
    
    return result;
}

// Funcție pentru a detecta și converti encoding-ul corect pentru română
function decodeRomanianText(buffer) {
    // Primul pas: încearcă Windows-1250 (cel mai comun pentru subtitrări românești)
    let text = decodeWindows1250(buffer);
    
    // Aplicăm corectarea diacriticelor greșite
    text = fixBrokenDiacritics(text);
    
    // Verificăm dacă conține caractere românești corecte
    if (/[șțăîâȘȚĂÎÂ]/.test(text) && !/�/.test(text)) {
        console.log('✅ Encoding detectat: windows-1250 (diacritice românești corecte)');
        return text;
    }
    
    // Dacă Windows-1250 nu merge, încercăm UTF-8
    try {
        text = buffer.toString('utf8');
        text = fixBrokenDiacritics(text);
        if (/[șțăîâȘȚĂÎÂ]/.test(text) && !/�/.test(text)) {
            console.log('✅ Encoding detectat: utf8');
            return text;
        }
    } catch (e) {
        // Ignore
    }
    
    // Ultimul resort: Latin1
    try {
        text = buffer.toString('latin1');
        text = fixBrokenDiacritics(text);
        console.log('⚠️ Folosesc latin1 ca fallback');
        return text;
    } catch (e) {
        // Ignore
    }
    
    // Dacă nimic nu merge, folosim Windows-1250 oricum
    console.log('⚠️ Folosesc windows-1250 ca fallback final');
    text = decodeWindows1250(buffer);
    return fixBrokenDiacritics(text);
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

// Funcție pentru a extrage ID-ul subtitrării din link
function extractSubtitleId(href) {
    const match = href.match(/id=(\d+)/);
    return match ? match[1] : null;
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
    // imdbId vine deja curat (fără :season:episode) din searchSubtitles
    const cacheKey = `search:${imdbId}:${season || 'x'}:${episode || 'x'}`;
    
    // TEMPORAR: Dezactivăm cache-ul pentru debugging
    // if (cache.has(cacheKey)) {
    //     const cached = cache.get(cacheKey);
    //     if (Date.now() - cached.timestamp < CACHE_TTL) {
    //         console.log('📦 Cache hit');
    //         return cached.data;
    //     }
    // }
    
    console.log('🔄 Fără cache - fetch nou de la titrari.ro');
    
    try {
        // Titrari.ro folosește "numaicautamcaneiesepenas" (Căutare avansată) pentru IMDB ID
        // z5 = IMDB ID (fără "tt")
        // z8=1 = limba română
        // z11=0 = toate tipurile (filme + seriale)
        const cleanImdbId = imdbId.replace('tt', '');
        const searchUrl = `https://titrari.ro/index.php?page=numaicautamcaneiesepenas&z7=&z2=&z5=${cleanImdbId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;
        
        console.log(`🔍 Caut pe titrari.ro: ${imdbId}${season ? ` (filtrare S${season}E${episode})` : ''}`);
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
        console.log(`🔍 Căutare pentru: ${type}${season ? ` - S${season}E${episode}` : ''}`);
        console.log(`⚙️ CODE VERSION: v1.0.6 - ARCHIVE SUPPORT ACTIVE`);
        
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
            
            console.log(`\n📌 Procesez: "${title}"`);
            console.log(`   Type: ${type}, Season: ${season}, Episode: ${episode}`);
            
            // Pentru seriale, verificăm dacă este episodul corect
            if (type === 'series' && season && episode) {
                const textToCheck = title + ' ' + allText;
                
                console.log(`🔍 Analizez pentru S${season}E${episode}: ${title}`);
                
                // Pattern-uri pentru a detecta episodul EXACT în titlu
                const exactEpisodePatterns = [
                    new RegExp(`S0*${season}E0*${episode}(?!\\d)`, 'i'),  // S12E13
                    new RegExp(`S0*${season}\\.E0*${episode}`, 'i'),      // S12.E13
                    new RegExp(`${season}x0*${episode}(?!\\d)`, 'i'),     // 12x13
                    new RegExp(`Sezon[ul\\s]*0*${season}[\\s.,E-]*(?:ep\\.?|episod)[\\s]*0*${episode}(?!\\d)`, 'i'),
                    new RegExp(`Season[\\s]*0*${season}[\\s.,E-]*(?:ep\\.?|episode)[\\s]*0*${episode}(?!\\d)`, 'i'),
                ];
                
                const hasExactEpisode = exactEpisodePatterns.some(p => p.test(textToCheck));
                
                if (hasExactEpisode) {
                    console.log(`   ✅ Match episod exact în titlu`);
                } else {
                    // Verificăm dacă menționează sezonul corect (posibil pack)
                    const seasonPatterns = [
                        new RegExp(`Sezon[ul\\s]*0*${season}(?![0-9])`, 'i'),
                        new RegExp(`Season[\\s]*0*${season}(?![0-9])`, 'i'),
                        new RegExp(`S0*${season}(?![0-9E])`, 'i'),
                    ];
                    
                    const hasSeason = seasonPatterns.some(p => p.test(textToCheck));
                    
                    if (hasSeason) {
                        console.log(`   ℹ️ Are sezonul ${season} - ACCEPTAT (vom verifica episodul în arhivă)`);
                        // ACCEPTĂM - verificarea episodului se va face în arhivă
                    } else {
                        console.log(`   ⏭️ SKIP: nu conține sezonul ${season}`);
                        continue;
                    }
                }
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
            
            const commentMatch = allText.match(/Comentariu[:\s]*([^\n]+)/i