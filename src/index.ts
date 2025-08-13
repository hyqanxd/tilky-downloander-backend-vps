// src/index.ts
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import youtubedl from 'youtube-dl-exec';
import instagramGetUrl from 'instagram-url-direct';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from 'ffmpeg-static';
import axios from 'axios';
import fluentFfmpeg from 'fluent-ffmpeg';
import cors, { CorsOptions } from 'cors';

interface DownloadRequest {
  url: string;
  format: 'audio' | 'video';
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, '../downloads');

// ---- CORS AYARI ----
// İzinli origin’leri .env’den de verebilirsin: CORS_ORIGINS=https://downloader.anitilky.xyz,https://www.downloader.anitilky.xyz
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean)) || [
  'https://downloader.anitilky.xyz',
  'https://www.downloader.anitilky.xyz',
];

const corsOptions: CorsOptions = {
  origin: (origin, cb) => {
    // Postman gibi origin’siz istekleri de kabul et
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // preflight cache
};

app.use(cors(corsOptions));
// Preflight'e açık cevap
app.options('*', cors(corsOptions));

// JSON ve temel header’lar
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);
// İndirme için Content-Disposition başlığını client’a gösterebilmek:
app.use((req, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  next();
});

// downloads klasörü garanti
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Basit sağlık kontrolü
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// Platform kontrolü
function checkPlatform(url: string): 'youtube' | 'instagram' | 'unsupported' {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  return 'unsupported';
}

// Rastgele dosya adı
function generateFileName(extension: string): string {
  const randomNum = Math.floor(Math.random() * 1_000_000);
  return `tilky-${randomNum}.${extension}`;
}

// ---- Final dosyayı servis eden endpoint ----
app.get('/api/download/:fileName', (req: Request, res: Response) => {
  const finalPath = path.join(DOWNLOADS_DIR, req.params.fileName);
  if (!fs.existsSync(finalPath)) {
    return res.status(404).json({ error: 'Dosya bulunamadı' });
  }
  res.download(finalPath, req.params.fileName, (err) => {
    if (err) console.error('Dosya gönderme hatası:', err);
    // İndirme bittiğinde dosyayı sil (isteğe bağlı)
    fs.unlink(finalPath, () => {});
  });
});

// ---- Instagram indirme ----
app.post('/api/download/instagram', async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
  const { url, format } = req.body;
  const timestampDir = path.join(DOWNLOADS_DIR, Date.now().toString());
  const tempFilePath = path.join(timestampDir, 'temp.mp4');

  try {
    if (checkPlatform(url) !== 'instagram') {
      return res.status(400).json({ error: 'Geçerli bir Instagram URL girin' });
    }
    fs.mkdirSync(timestampDir, { recursive: true });

    const result = await instagramGetUrl(url);
    if (!result.url_list?.[0]) throw new Error('Video URL bulunamadı');

    // Videoyu önce temp’e indir
    const response = await axios.get(result.url_list[0], { responseType: 'stream' });
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const finalPath = path.join(DOWNLOADS_DIR, fileName);

    if (format === 'audio') {
      if (!ffmpeg) throw new Error('FFmpeg bulunamadı');
      await new Promise<void>((resolve, reject) => {
        fluentFfmpeg()
          .setFfmpegPath(ffmpeg)
          .input(tempFilePath)
          .toFormat('mp3')
          .on('end', resolve)
          .on('error', reject)
          .save(finalPath);
      });
      fs.rmSync(timestampDir, { recursive: true, force: true });
    } else {
      // mp4 olarak final’e taşı
      fs.renameSync(tempFilePath, finalPath);
      fs.rmSync(timestampDir, { recursive: true, force: true });
    }

    // Frontend’e final indirme URL’sini döndür
    return res.json({
      success: true,
      fileName,
      downloadUrl: `/api/download/${fileName}`,
    });

  } catch (err) {
    console.error('Instagram indirme hatası:', err);
    fs.rmSync(timestampDir, { recursive: true, force: true });
    return res.status(500).json({ error: 'Video indirilemedi' });
  }
});

// ---- YouTube indirme ----
app.post('/api/download/youtube', async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
  const { url, format } = req.body;
  const timestampDir = path.join(DOWNLOADS_DIR, Date.now().toString());
  fs.mkdirSync(timestampDir, { recursive: true });

  try {
    if (checkPlatform(url) !== 'youtube') {
      return res.status(400).json({ error: 'Geçerli bir YouTube URL girin' });
    }

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const tempOutput = path.join(timestampDir, fileName);
    const finalPath = path.join(DOWNLOADS_DIR, fileName);

    const options =
      format === 'audio'
        ? {
            output: tempOutput,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: 0,
            addMetadata: true,
            noCheckCertificate: true,
            ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {}),
          }
        : {
            output: tempOutput,
            format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            addMetadata: true,
            noCheckCertificate: true,
            ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {}),
          };

    await youtubedl(url, options);

    if (!fs.existsSync(tempOutput)) throw new Error('İndirilen dosya bulunamadı');

    // Final klasöre taşı ve temp’i sil
    fs.renameSync(tempOutput, finalPath);
    fs.rmSync(timestampDir, { recursive: true, force: true });

    return res.json({
      success: true,
      fileName,
      downloadUrl: `/api/download/${fileName}`,
    });
  } catch (err) {
    console.error('YouTube indirme hatası:', err);
    fs.rmSync(timestampDir, { recursive: true, force: true });
    return res.status(500).json({ error: 'Video indirilemedi' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
