const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const activeDownloads = new Map();

function detectPlatform(url) {
    try {
        const parsedUrl = new URL(url);
        const host = parsedUrl.hostname;

        if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
        if (host.includes('tiktok.com')) return 'tiktok';
        if (host.includes('instagram.com')) return 'instagram';
    } catch (e) {
        return 'unknown';
    }
    return 'unknown';
}

app.get('/api/status', (req, res) => {
    const child = spawn('yt-dlp', ['--version']);
    let output = '';

    child.stdout.on('data', (d) => output += d);

    child.on('error', () => {
        return res.json({ status: 'ok', yt_dlp: 'not installed', downloads_dir: DOWNLOAD_DIR });
    });

    child.on('close', (code) => {
        if (code !== 0) res.json({ status: 'ok', yt_dlp: 'not installed' });
        else res.json({ status: 'ok', yt_dlp: output.trim(), downloads_dir: DOWNLOAD_DIR });
    });
});

app.post('/api/info', (req, res) => {
    console.log('DEBUG /api/info received URL:', req.body.url);
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (url.includes('tiktok.com/t/') && !url.endsWith('/')) { url += '/'; }
    console.log('DEBUG after fix URL:', url);

    const platform = detectPlatform(url);
    if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported or invalid URL' });

    if (platform === 'instagram') {
        const args = ['-j', '--cookies', 'cookies.txt', url];
        const child = spawn('gallery-dl', args);
        let stdout = '', stderr = '';

        child.stdout.on('data', (d) => stdout += d);
        child.stderr.on('data', (d) => stderr += d);

        child.on('error', (err) => {
            console.log('DEBUG gallery-dl missing, falling back to basic layout parsing');
            return sendInstagramFallback(res, platform);
        });

        child.on('close', (code) => {
            if (!stdout.trim()) {
                console.log('DEBUG gallery-dl stderr:', stderr);
                return sendInstagramFallback(res, platform);
            }
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
                            
                            if (meta.display_url || meta.image_versions2) {
                                foundImages.push(meta);
                            }
                        }
                    } catch(e) {}
                }

                if (foundImages.length === 0 && fallbackMeta) {
                    foundImages.push(fallbackMeta);
                }

                if (foundImages.length === 0) throw new Error("Could not parse image metadata");

                const dynamicFormats = foundImages.map((img, idx) => {
                    return {
                        format_id: `image_${idx + 1}`, 
                        ext: 'jpg',
                        quality: foundImages.length > 1 ? `Download Image #${idx + 1}` : 'Original Image',
                        resolution: img.dimensions ? `${img.dimensions.width}x${img.dimensions.height}` : 'High Res',
                        filesize: null,
                        has_audio: false
                    };
                });

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
            } catch (e) {
                sendInstagramFallback(res, platform);
            }
        });
    } else {
        let args = ['-j', '--no-warnings', '--ignore-no-formats-error'];
        if (platform === 'tiktok') {
            args.push('--cookies', 'tiktok_cookies.txt');
        }
        args.push(url);

        const child = spawn('yt-dlp', args);
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => stdout += d);
        child.stderr.on('data', (d) => stderr += d);

        child.on('error', (err) => {
            return res.status(500).json({ error: 'Downloader engine error', details: err.message });
        });

        child.on('close', (code) => {
            if (code !== 0 || !stdout.trim()) {
                console.log('DEBUG yt-dlp stderr:', stderr);
                return res.status(500).json({ error: 'Failed to fetch info', details: stderr || 'No output' });
            }
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
                    }))
                    .sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));

                const audioFormats = (info.formats || []).filter(f => f.vcodec === 'none' && f.acodec !== 'none')
                    .map(f => ({ format_id: f.format_id, ext: f.ext, quality: f.format_note || (f.abr ? f.abr + 'k' : 'audio'), abr: f.abr, filesize: f.filesize || f.filesize_approx }))
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

                if (formats.length === 0 && platform === 'tiktok') {
                    formats.push({ format_id: 'best', ext: 'mp4', quality: 'Best Quality', resolution: info.resolution || 'Unknown', filesize: info.filesize || info.filesize_approx, has_audio: true });
                }

                res.json({
                    title: info.title || 'Unknown',
                    uploader: info.uploader || info.channel || 'Unknown',
                    duration: info.duration || 0,
                    thumbnail: info.thumbnail || '',
                    view_count: info.view_count || 0,
                    platform: platform,
                    formats: formats.slice(0, 15),
                    audio_formats: audioFormats.slice(0, 5)
                });
            } catch (e) {
                res.status(500).json({ error: 'Parse error', details: e.message });
            }
        });
    }
});

function sendInstagramFallback(res, platform) {
    return res.json({
        title: 'Instagram Post',
        uploader: 'Instagram User',
        duration: 0,
        thumbnail: '',
        view_count: 0,
        platform: platform,
        formats: [{ format_id: 'best', ext: 'jpg', quality: 'Original Image', resolution: 'High Res', filesize: null, has_audio: false }],
        audio_formats: []
    });
}

app.post('/api/download', (req, res) => {
    let { url, format_id, type } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (url.includes('tiktok.com/t/') && !url.endsWith('/')) { url += '/'; }
    console.log('DEBUG after fix URL:', url);

    const platform = detectPlatform(url);
    const downloadId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    let childProcess;

    if (platform === 'instagram') {
        const args = [
            '--directory', DOWNLOAD_DIR,
            '-o', 'directory=[]',
            '-o', `filename=${downloadId}_instagram_{id}.{extension}`,
            '--cookies', 'cookies.txt',
            url
        ];

        // FIX: Format explicit slide targeting ranges (e.g., '3-3' instead of just '3')
        if (format_id && format_id.startsWith('image_')) {
            const rangeIndex = parseInt(format_id.replace('image_', ''));
            if (!isNaN(rangeIndex)) {
                args.push('--range', `${rangeIndex}-${rangeIndex}`);
            }
        }

        childProcess = spawn('gallery-dl', args);
        activeDownloads.set(downloadId, { process: childProcess, url, status: 'downloading', progress: 50, filename: null, started: Date.now() });

        childProcess.stdout.on('data', (data) => {
            const dl = activeDownloads.get(downloadId);
            if (dl) dl.progress = 75;
        });

        childProcess.on('error', (err) => {
            console.error('Instagram download process error:', err);
            const dl = activeDownloads.get(downloadId);
            if (dl) {
                dl.status = 'error';
                dl.error = 'Gallery-dl is missing or failed on cloud instance.';
            }
        });

    } else {
        const outputTemplate = path.join(DOWNLOAD_DIR, `${downloadId}_%(title)s.%(ext)s`);
        let args;
        if (type === 'audio') {
            args = ['-f', format_id || 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, '--no-warnings', '--newline', url];
        } else if (platform === 'tiktok') {
            args = ['-f', format_id || 'best', '-o', outputTemplate, '--no-warnings', '--newline', '--cookies', 'tiktok_cookies.txt', '--embed-metadata', url];
        } else {
            const formatSpec = format_id ? format_id + '+bestaudio/best' : 'bestvideo+bestaudio/best';
            args = ['-f', formatSpec, '--merge-output-format', 'mp4', '-o', outputTemplate, '--no-warnings', '--newline', url];
        }

        childProcess = spawn('yt-dlp', args);
        activeDownloads.set(downloadId, { process: childProcess, url, status: 'downloading', progress: 0, filename: null, started: Date.now() });

        childProcess.stdout.on('data', (data) => {
            const line = data.toString();
            const dl = activeDownloads.get(downloadId);
            if (!dl) return;
            const match = line.match(/(\d+\.?\d*)%/);
            if (match) dl.progress = parseFloat(match[1]);
        });

        childProcess.on('error', (err) => {
            const dl = activeDownloads.get(downloadId);
            if (dl) {
                dl.status = 'error';
                dl.error = 'Downloader process error: ' + err.message;
            }
        });
    }

    childProcess.on('close', (code) => {
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;
        if (code === 0) {
            dl.status = 'completed'; dl.progress = 100;
            fs.readdir(DOWNLOAD_DIR, (err, files) => {
                if (!err) {
                    const matchedFile = files.find(f => f.startsWith(downloadId) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
                    if (matchedFile) dl.filename = matchedFile;
                }
            });
        } else {
            if (dl.status !== 'error') {
                dl.status = 'error'; 
                dl.error = 'Download failed (code: ' + code + ')';
            }
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
    console.log('Platforms: YouTube, TikTok (no watermark), Instagram');
});
