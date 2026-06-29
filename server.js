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
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    return 'unknown';
}

app.get('/api/status', (req, res) => {
    const child = spawn('yt-dlp', ['--version']);
    let output = '';
    child.stdout.on('data', (d) => output += d);
    child.on('close', (code) => {
        if (code !== 0) res.json({ status: 'ok', yt_dlp: 'not installed' });
        else res.json({ status: 'ok', yt_dlp: output.trim(), downloads_dir: DOWNLOAD_DIR });
    });
});

app.post('/api/info', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const platform = detectPlatform(url);
    if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported URL' });

    let args = ['-j', '--no-warnings'];
    if (platform === 'tiktok') {
        args.push('--user-agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36');
    } else if (platform === 'instagram') {
    args.push('--cookies', 'cookies.txt');
        args.push('--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36');
    }
    args.push(url);

    const child = spawn('yt-dlp', args);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);

    child.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) {
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

            if (formats.length === 0 && (platform === 'tiktok' || platform === 'instagram')) {
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
});

app.post('/api/download', (req, res) => {
    const { url, format_id, type } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const platform = detectPlatform(url);
    const downloadId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const outputTemplate = path.join(DOWNLOAD_DIR, '%(title)s [%(id)s].%(ext)s');

    let args;
    if (type === 'audio') {
        args = ['-f', format_id || 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, '--no-warnings', '--newline', url];
    } else if (platform === 'tiktok') {
        args = ['-f', format_id || 'best', '-o', outputTemplate, '--no-warnings', '--newline', '--user-agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36', '--embed-metadata', url];
    } else if (platform === 'instagram') {
        args = ['-f', format_id || 'best', '-o', outputTemplate, '--no-warnings', '--newline', '--cookies', 'cookies.txt', '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36', url];
    } else {
        const formatSpec = format_id ? format_id + '+bestaudio/best' : 'bestvideo+bestaudio/best';
        args = ['-f', formatSpec, '--merge-output-format', 'mp4', '-o', outputTemplate, '--no-warnings', '--newline', url];
    }

    const dlProcess = spawn('yt-dlp', args);
    activeDownloads.set(downloadId, { process: dlProcess, url, status: 'downloading', progress: 0, filename: null, started: Date.now() });

    dlProcess.stdout.on('data', (data) => {
        const line = data.toString();
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) dl.progress = parseFloat(match[1]);
    });

    dlProcess.on('close', (code) => {
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;
        if (code === 0) {
            dl.status = 'completed'; dl.progress = 100;
            fs.readdir(DOWNLOAD_DIR, (err, files) => {
                if (!err) {
                    const latest = files.filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'))
                        .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime }))
                        .sort((a, b) => b.time - a.time)[0];
                    if (latest) dl.filename = latest.name;
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
    console.log('Platforms: YouTube, TikTok (no watermark), Instagram');
});
