import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import youtubedl from 'youtube-dl-exec';
import instagramGetUrl from 'instagram-url-direct';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from 'ffmpeg-static';
import axios from 'axios';
import fluentFfmpeg from 'fluent-ffmpeg';

interface DownloadRequest {
  url: string;
  format: 'audio' | 'video';
}

interface ProgressEvent {
  total?: number;
  loaded?: number;
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
app.use(cors({
  origin: [
    'https://downloader.anitilky.xyz',
    'https://www.downloader.anitilky.xyz',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:8080'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers'
  ],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  optionsSuccessStatus: 200,
  preflightContinue: false
}));

// Explicit preflight handling for all routes
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'TilkyDownloader API is running' 
  });
});

// API status endpoint
app.get('/api/status', (req: Request, res: Response) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.json({ 
    status: 'active',
    version: '1.0.0',
    endpoints: {
      instagram: '/api/download/instagram',
      youtube: '/api/download/youtube'
    }
  });
});

// Platform kontrolü fonksiyonu
function checkPlatform(url: string): string {
  if (url.includes('instagram.com') || url.includes('instagr.am')) {
    return 'instagram';
  } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  }
  return 'unknown';
}

// URL'nin hangtsooluştur
function generateFileName(extension: string): string {
  const randomNum = Math.floor(Math.random() * 1000000);
  return `tilky-${randomNum}.${extension}`;
}

// Instagram video indirme endpoint'i
app.post('/api/download/instagram', async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
  const timestampDir = path.join(process.cwd(), 'downloads', Date.now().toString());
  
  try {
    const { url, format } = req.body;

    // Platform kontrolü
    const platform = checkPlatform(url);
    if (platform !== 'instagram') {
      return res.status(400).json({ error: 'Lütfen geçerli bir Instagram URL\'si girin' });
    }

    if (!fs.existsSync(timestampDir)) {
      fs.mkdirSync(timestampDir, { recursive: true });
    }

    console.log('Instagram URL işleniyor:', url);

    // Get Instagram video URL - use yt-dlp as primary method
    let bestQualityUrl;
    
    // Primary method: yt-dlp (more reliable for Instagram)
    try {
      console.log('yt-dlp ile Instagram URL alınıyor...');
      const tempInfo = await youtubedl(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        format: 'best[height<=1080]/best',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        referer: 'https://www.instagram.com/'
      } as any);
      
      if (tempInfo && typeof tempInfo === 'object') {
        const infoObj = tempInfo as any;
        if (infoObj.url) {
          bestQualityUrl = infoObj.url;
          console.log('yt-dlp ile Instagram URL başarıyla alındı');
        } else if (infoObj.formats && infoObj.formats.length > 0) {
          // En iyi formatı seç
          const formats = infoObj.formats.sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
          bestQualityUrl = formats[0].url;
          console.log('yt-dlp ile Instagram format URL alındı');
        } else {
          throw new Error('yt-dlp ile URL bulunamadı');
        }
      } else {
        throw new Error('yt-dlp ile bilgi alınamadı');
      }
    } catch (ytdlError) {
      console.error('yt-dlp ile Instagram hatası:', ytdlError);
      
      // Fallback method: instagram-url-direct
      try {
        console.log('instagram-url-direct ile deneniyor...');
        const result = await instagramGetUrl(url);
        if (result.url_list && result.url_list.length > 0) {
          bestQualityUrl = result.url_list[0];
          // En yüksek kaliteli URL'yi seç
          if (result.url_list.length > 1) {
            for (const videoUrl of result.url_list) {
              if (videoUrl && (videoUrl.includes('720') || videoUrl.includes('1080'))) {
                bestQualityUrl = videoUrl;
                break;
              }
            }
          }
          console.log('instagram-url-direct ile URL alındı');
        } else {
          throw new Error('instagram-url-direct ile URL listesi boş');
        }
      } catch (instagramError) {
        console.error('instagram-url-direct hatası:', instagramError);
        throw new Error('Instagram videosu hiçbir yöntemle alınamadı. URL\'yi kontrol edin veya daha sonra tekrar deneyin.');
      }
    }

    if (!bestQualityUrl) {
      throw new Error('Video URL bulunamadı');
    }

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const filePath = path.join(timestampDir, fileName);
    const tempFilePath = path.join(timestampDir, 'temp.mp4');

    // Önce videoyu indir
    const response = await axios({
      method: 'GET',
      url: bestQualityUrl,
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      onDownloadProgress: (progressEvent: any) => {
        if (progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 50) / progressEvent.total);
          res.write(JSON.stringify({ progress, status: 'downloading' }) + '\n');
        }
      }
    });

    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });

    if (format === 'audio' && ffmpeg) {
      // MP3'e dönüştür
      await new Promise<void>((resolve, reject) => {
        if (!ffmpeg) {
          reject(new Error('FFmpeg yolu bulunamadı'));
          return;
        }

        fluentFfmpeg()
          .setFfmpegPath(ffmpeg)
          .input(tempFilePath)
          .toFormat('mp3')
          .audioBitrate(320)
          .audioFrequency(48000)
          .audioChannels(2)
          .audioCodec('libmp3lame')
          .on('progress', (progress: { percent?: number }) => {
            const percent = 50 + (progress.percent ? Math.min(progress.percent, 100) / 2 : 0);
            res.write(JSON.stringify({ progress: percent, status: 'downloading' }) + '\n');
          })
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .save(filePath);
      });

      // Geçici dosyayı sil
      await fs.promises.unlink(tempFilePath);
    } else {
      // MP4 için dosyayı taşı
      await fs.promises.rename(tempFilePath, filePath);
    }

    res.write(JSON.stringify({ progress: 100, status: 'completed', fileName }) + '\n');
    res.end();

    // İndirme tamamlandıktan sonra dosyayı gönder
    app.get(`/api/download/${fileName}`, (req: Request, res: Response) => {
      res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.header('Access-Control-Allow-Credentials', 'true');
      
      res.download(filePath, fileName, (err: Error | null) => {
        if (err) {
          console.error('Dosya gönderme hatası:', err);
        }
        // İndirme tamamlandıktan sonra temizlik yap
        setTimeout(() => {
          fs.rm(timestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
            if (rmErr) {
              console.error('Dizin silme hatası:', rmErr);
            }
          });
        }, 5000);
      });
    });

  } catch (error) {
    console.error('Instagram indirme hatası:', error);
    // Hata durumunda da temizlik yap
    fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Video indirilemedi' });
    }
  }
});

// YouTube video indirme endpoint'i
app.post('/api/download/youtube', async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
  const timestampDir = path.join(process.cwd(), 'downloads', Date.now().toString());
  
  try {
    const { url, format } = req.body;

    // Platform kontrolü
    const platform = checkPlatform(url);
    if (platform !== 'youtube') {
      return res.status(400).json({ error: 'Lütfen geçerli bir YouTube URL\'si girin' });
    }

    if (!fs.existsSync(timestampDir)) {
      fs.mkdirSync(timestampDir, { recursive: true });
    }

    console.log('YouTube URL işleniyor:', url, 'Format:', format);

    // Önce video bilgilerini al
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true
    });

    if (!info || typeof info !== 'object') {
      throw new Error('Video bilgileri alınamadı');
    }

    const videoInfo = info as any;
    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const outputPath = path.join(timestampDir, fileName);

    const options = format === 'audio' ? {
      output: outputPath,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      addMetadata: true,
      noCheckCertificate: true,
      noWarnings: true,
      ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {})
    } : {
      output: outputPath,
      format: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]/bestvideo+bestaudio/best',
      mergeOutputFormat: 'mp4',
      addMetadata: true,
      noCheckCertificate: true,
      noWarnings: true,
      ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {})
    } as any;

    // İndirme işlemini başlat
    try {
      const download = youtubedl.exec(url, options);
      let lastProgress = 0;

      // İlerleme durumunu izle
      if (download.stdout) {
        download.stdout.on('data', (data: any) => {
          const output = data.toString();
          const progressMatch = output.match(/(\\d+\\.\\d+)%/);
          if (progressMatch) {
            const progress = parseFloat(progressMatch[1]);
            if (progress > lastProgress) {
              lastProgress = progress;
              res.write(JSON.stringify({ progress, status: 'downloading' }) + '\n');
            }
          }
        });
      }

      await download;
    } catch (downloadError) {
      console.error('İlk indirme denemesi başarısız:', downloadError);
      
      // Alternatif formatta tekrar dene
      const alternativeOptions = {
        ...options,
        format: format === 'audio' ? 'bestaudio[ext=m4a]/bestaudio' : 'best[height<=1080]/bestvideo+bestaudio/best'
      } as any;
      
      const download = youtubedl.exec(url, alternativeOptions);
      let lastProgress = 0;
      
      if (download.stdout) {
        download.stdout.on('data', (data: any) => {
          const output = data.toString();
          const progressMatch = output.match(/(\\d+\\.\\d+)%/);
          if (progressMatch) {
            const progress = parseFloat(progressMatch[1]);
            if (progress > lastProgress) {
              lastProgress = progress;
              res.write(JSON.stringify({ progress, status: 'downloading' }) + '\n');
            }
          }
        });
      }
      
      await download;
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('İndirilen dosya bulunamadı');
    }

    res.write(JSON.stringify({ progress: 100, status: 'completed', fileName }) + '\n');
    res.end();

    // İndirme tamamlandıktan sonra dosyayı gönder
    app.get(`/api/download/${fileName}`, (req: Request, res: Response) => {
      res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.header('Access-Control-Allow-Credentials', 'true');
      
      res.download(outputPath, fileName, (err: Error | null) => {
        if (err) {
          console.error('Dosya gönderme hatası:', err);
        }
        // İndirme tamamlandıktan sonra temizlik yap
        setTimeout(() => {
          fs.rm(timestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
            if (rmErr) {
              console.error('Dizin silme hatası:', rmErr);
            }
          });
        }, 5000);
      });
    });

  } catch (error) {
    console.error('YouTube indirme hatası:', error);
    // Hata durumunda da temizlik yap
    fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Video indirilemedi' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});