const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BIN_DIR = path.join(__dirname, 'bin');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

// Safely append our custom binary directory to the system PATH without wiping existing paths
process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const activeDownloads = new Map();

// Clear old standalone binary hacks to keep things clean
function updateBinaryTools() {
    console.log('Synchronizing downloader tools...');
    try {
        execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${path.join(BIN_DIR, 'yt-dlp')}`);
        execSync(`chmod a+rx ${path.join(BIN_DIR, 'yt-dlp')}`);
        console.log('Fresh yt-dlp binary linked.');
    } catch (err) {
        console.log('Updater update notification:', err.message);
    }
}
updateBinaryTools();

function detectPlatform(url) {
    try {
        const parsedUrl = new URL(url);
        const host = parsedUrl.hostname;
        if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
        if (host.includes('tiktok.com')) return 'tiktok';
        if (host.includes('instagram.com')) return 'instagram';
    } catch (e) { return 'unknown'; }
    return 'unknown';
}

app.get('/api/status', (req, res) => {
    const child = spawn('yt-dlp', ['--version']);
    let output = '';
    child.stdout.on('data', (d) => output += d);
    child.on('error', () => res.json({ status: 'ok', yt_dlp: 'not installed', downloads_dir: DOWNLOAD_DIR }));
    child.on('close', () => {
        res.json({ status: 'ok', yt_dlp: 'Custom Latest Build ready', downloads_dir: DOWNLOAD_DIR });
    });
});

app.post('/api/info', (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (url.includes('tiktok.com/t/') && !url.endsWith('/')) { url += '/'; }

    const platform = detectPlatform(url);
    if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported URL' });

    if (platform === 'instagram') {
        const args = ['-j', '--cookies', 'cookies.txt', url];
        const child = spawn('gallery-dl', args);
        let stdout = '', stderr = '';

        child.stdout.on('data', (d) => stdout += d);
        child.stderr.on('data', (d) => stderr += d);

        child.on('error', () => sendInstagramFallback(res, platform));
        child.on('close', () => {
            if (!stdout.trim()) return sendInstagramFallback(res, platform);
            try {
                const lines = stdout.trim().split('\n');
                let foundImages = [];
                let fallbackMeta = null;

                for (let line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (Array.isArray(parsed) && parsed[2]) {
                            const meta = parsed[2];
                            if (!fallbackMeta) fallbackMeta = meta;
                            if (meta.display_url || meta.shortcode) foundImages.push(meta);
                        }
                    } catch(e) {}
                }

                // Match exact images based on data payloads
                foundImages = foundImages.filter((v, i, a) => a.findIndex(t => (t.display_url === v.display_url || t.id === v.id)) === i);
                if (foundImages.length === 0 && fallbackMeta) foundImages.push(fallbackMeta);
                if (foundImages.length === 0) throw new Error("Metadata parse error");

                const dynamicFormats = foundImages.map((img, idx) => ({
                    format_id: `slide_${idx + 1}`, 
                    ext: 'jpg',
                    quality: foundImages.length > 1 ? `Download Image #${idx + 1}` : 'Original Image',
                    resolution: img.dimensions ? `${img.dimensions.width}x${img.dimensions.height}` : 'High Res',
                    filesize: null,
                    has_audio: false
                }));

                res.json({
                    title: foundImages[0].description || foundImages[0].shortcode || 'Instagram Post',
                    uploader: foundImages[0].username || 'Instagram User',
                    duration: 0,
                    thumbnail: foundImages[0].display_url || '',
                    view_count: 0,
                    platform: platform,
                    formats: dynamicFormats,
                    audio_formats: []
                });
            } catch (e) { sendInstagramFallback(res, platform); }
        });
    } else {
        let args = ['-j', '--no-warnings', '--ignore-no-formats-error'];
        if (platform === 'tiktok') args.push('--cookies', 'tiktok_cookies.txt');
        args.push(url);

        const child = spawn('yt-dlp', args);
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => stdout += d);
        child.stderr.on('data', (d) => stderr += d);

        child.on('close', () => {
            if (!stdout.trim()) return res.status(500).json({ error: 'Fetch failed', details: stderr });
            try {
                const info = JSON.parse(stdout.trim().split('\n')[0]);
                const formats = (info.formats || []).filter(f => f.vcodec !== 'none')
                    .map(f => ({
                        format_id: f.format_id,
                        ext: f.ext,
                        quality: f.quality_label || f.format_note || f.resolution,
                        resolution: f.resolution,
                        filesize: f.filesize || f.filesize_approx,
                        has_audio: f.acodec !== 'none'
                    })).sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));

                const audioFormats = (info.formats || []).filter(f => f.vcodec === 'none' && f.acodec !== 'none')
                    .map(f => ({ format_id: f.format_id, ext: f.ext, quality: f.format_note || (f.abr ? f.abr + 'k' : 'audio'), abr: f.abr, filesize: f.filesize || f.filesize_approx }))
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

                if (formats.length === 0 && platform === 'tiktok') {
                    formats.push({ format_id: 'best', ext: 'mp4', quality: 'Best Quality', resolution: info.resolution || 'Unknown', filesize: info.filesize || info.filesize_approx, has_audio: true });
                }

                res.json({
                    title: info.title || 'Unknown', uploader: info.uploader || info.channel || 'Unknown',
                    duration: info.duration || 0, thumbnail: info.thumbnail || '', view_count: info.view_count || 0,
                    platform: platform, formats: formats.slice(0, 15), audio_formats: audioFormats.slice(0, 5)
                });
            } catch (e) { res.status(500).json({ error: 'Parse error', details: e.message }); }
        });
    }
});

function sendInstagramFallback(res, platform) {
    return res.json({
        title: 'Instagram Post', uploader: 'Instagram User', duration: 0, thumbnail: '', view_count: 0, platform: platform,
        formats: [{ format_id: 'best', ext: 'jpg', quality: 'Original Image', resolution: 'High Res', filesize: null, has_audio: false }],
        audio_formats: []
    });
}

app.post('/api/download', (req, res) => {
    let { url, format_id, type } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (url.includes('tiktok.com/t/') && !url.endsWith('/')) { url += '/'; }

    const platform = detectPlatform(url);
    const downloadId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    let childProcess;

    if (platform === 'instagram') {
        // Safe approach: Use gallery-dl directly to isolated destinations
        const targetFilename = `${downloadId}_instagram_photo.jpg`;
        const fullFilePath = path.join(DOWNLOAD_DIR, targetFilename);
        
        let args = ['--cookies', 'cookies.txt', '--destination', fullFilePath];
        if (format_id && format_id.startsWith('slide_')) {
            const index = format_id.replace('slide_', '');
            args.push('--range', index);
        }
        args.push(url);

        childProcess = spawn('gallery-dl', args);
    } else {
        const outputTemplate = path.join(DOWNLOAD_DIR, `${downloadId}_%(title)s.%(ext)s`);
        let args = [];
        
        if (type === 'audio') {
            args = ['-f', format_id || 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, '--no-warnings', '--newline', url];
        } else if (platform === 'tiktok') {
            args = ['-f', format_id || 'best', '-o', outputTemplate, '--no-warnings', '--newline', '--cookies', 'tiktok_cookies.txt', '--embed-metadata', url];
        } else {
            const formatSpec = format_id ? format_id + '+bestaudio/best' : 'bestvideo+bestaudio/best';
            args = ['-f', formatSpec, '--merge-output-format', 'mp4', '-o', outputTemplate, '--no-warnings', '--newline', url];
        }
        childProcess = spawn('yt-dlp', args);
    }

    activeDownloads.set(downloadId, { process: childProcess, url, status: 'downloading', progress: 0, filename: null, started: Date.now() });

    childProcess.stdout.on('data', (data) => {
        const line = data.toString();
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) dl.progress = parseFloat(match[1]);
        else dl.progress = 45;
    });

    childProcess.on('error', (err) => {
        const dl = activeDownloads.get(downloadId);
        if (dl) { dl.status = 'error'; dl.error = err.message; }
    });

    childProcess.on('close', (code) => {
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;
        if (code === 0 || platform === 'instagram') {
            dl.status = 'completed'; dl.progress = 100;
            fs.readdir(DOWNLOAD_DIR, (err, files) => {
                if (!err) {
                    const matchedFile = files.find(f => f.startsWith(downloadId) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
                    if (matchedFile) dl.filename = matchedFile;
                }
            });
        } else {
            dl.status = 'error'; dl.error = 'Download failed (code: ' + code + ')';
        }
    });

    res.json({ downloadId, status: 'started' });
});

app.get('/api/download/:id', (req, res) => {
    const dl = activeDownloads.get(req.params.id);
    if (!dl) return res.status(404).json({ error: 'Not found' });
    res.json({ status: dl.status, progress: dl.progress, filename: dl.filename, error: dl.error || null });
});

app.get('/api/files', (req, res) => {
    fs.readdir(DOWNLOAD_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: 'Failed to read directory' });
        const fileList = files.filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'))
            .map(f => { const stat = fs.statSync(path.join(DOWNLOAD_DIR, f)); return { name: f, size: stat.size, created: stat.mtime, url: '/downloads/' + encodeURIComponent(f) }; })
            .sort((a, b) => b.created - a.created);
        res.json(fileList);
    });
});

app.get('/downloads/:filename', (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, decodeURIComponent(req.params.filename));
    if (!filePath.startsWith(DOWNLOAD_DIR) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.download(filePath);
});

app.delete('/api/files/:filename', (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, decodeURIComponent(req.params.filename));
    if (!filePath.startsWith(DOWNLOAD_DIR)) return res.status(403).json({ error: 'Access denied' });
    fs.unlink(filePath, (err) => { if (err) return res.status(500).json({ error: 'Failed' }); res.json({ message: 'Deleted' }); });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('Video Downloader running at http://localhost:' + PORT);
});
