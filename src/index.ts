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
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json());

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
  const timestampDir = path.join(__dirname, '../downloads', Date.now().toString());
  
  try {
    const { url, format } = req.body;

    // Input validation
    if (!url || !format) {
      return res.status(400).json({ error: 'URL ve format gerekli' });
    }

    // Platform kontrolü
    const platform = checkPlatform(url);
    if (platform !== 'instagram') {
      return res.status(400).json({ error: 'Lütfen geçerli bir Instagram URL\'si girin' });
    }

    // Create downloads directory if it doesn't exist
    if (!fs.existsSync(timestampDir)) {
      fs.mkdirSync(timestampDir, { recursive: true });
    }

    console.log('Instagram URL işleniyor:', url);

    // Get Instagram video URL - try multiple methods
    let bestQualityUrl;
    
    try {
      // Method 1: Try instagram-url-direct first
      console.log('Instagram URL alınıyor (Method 1)...');
      const result = await instagramGetUrl(url);
      console.log('Instagram URL sonucu:', result);
      
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
        console.log('Seçilen en yüksek kalite URL:', bestQualityUrl);
      } else {
        throw new Error('URL listesi boş');
      }
    } catch (instagramError) {
      console.error('Instagram URL alma hatası (Method 1):', instagramError);
      
      // Method 2: Try using yt-dlp as fallback for Instagram
      console.log('Instagram için yt-dlp kullanılıyor (Method 2)...');
      try {
        const tempInfo = await youtubedl(url, {
          dumpSingleJson: true,
          noCheckCertificates: true,
          noWarnings: true,
          format: 'best'
        });
        
        if (tempInfo && typeof tempInfo === 'object') {
          const infoObj = tempInfo as any;
          if (infoObj.url) {
            bestQualityUrl = infoObj.url;
            console.log('yt-dlp ile Instagram URL alındı:', bestQualityUrl);
          } else {
            throw new Error('yt-dlp ile URL bulunamadı');
          }
        } else {
          throw new Error('yt-dlp ile bilgi alınamadı');
        }
      } catch (ytdlError) {
        console.error('yt-dlp ile Instagram hatası:', ytdlError);
        throw new Error('Instagram videosu hiçbir yöntemle alınamadı. Lütfen URL\'yi kontrol edin veya daha sonra tekrar deneyin.');
      }
    }

    if (!bestQualityUrl) {
      throw new Error('Video URL bulunamadı');
    }

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const filePath = path.join(timestampDir, fileName);
    const tempFilePath = path.join(timestampDir, 'temp.mp4');

    console.log('Video indiriliyor:', bestQualityUrl);

    // Download video with best quality
    const response = await axios({
      method: 'GET',
      url: bestQualityUrl,
      responseType: 'stream',
      timeout: 60000, // 60 second timeout for high quality videos
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        'Accept-Encoding': 'identity',
        'Range': 'bytes=0-'
      }
    });

    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });

    console.log('Video indirildi, işleniyor...');

    if (format === 'audio' && ffmpeg) {
      // Convert to high quality MP3
      await new Promise<void>((resolve, reject) => {
        if (!ffmpeg) {
          reject(new Error('FFmpeg yolu bulunamadı'));
          return;
        }

        fluentFfmpeg()
          .setFfmpegPath(ffmpeg)
          .input(tempFilePath)
          .toFormat('mp3')
          .audioBitrate(320) // En yüksek kalite: 320 kbps
          .audioFrequency(48000) // Yüksek sample rate
          .audioChannels(2) // Stereo
          .audioCodec('libmp3lame') // En iyi MP3 encoder
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .save(filePath);
      });

      // Delete temp file
      await fs.promises.unlink(tempFilePath);
    } else {
      // Move file for MP4
      await fs.promises.rename(tempFilePath, filePath);
    }

    console.log('İşlem tamamlandı:', fileName);

    // Return success response with download URL
    res.json({ 
      success: true, 
      fileName, 
      downloadUrl: `/api/download/${fileName}`,
      message: 'Video başarıyla işlendi (En yüksek kalite)' 
    });

    // Create download endpoint for this file
    const currentTimestampDir = timestampDir; // Capture for closure
    app.get(`/api/download/${fileName}`, (req: Request, res: Response) => {
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Dosya bulunamadı' });
      }

      res.download(filePath, fileName, (err: Error | null) => {
        if (err) {
          console.error('Dosya gönderme hatası:', err);
        }
        // Clean up after download
        setTimeout(() => {
          fs.rm(currentTimestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
            if (rmErr) {
              console.error('Dizin silme hatası:', rmErr);
            }
          });
        }, 5000); // Wait 5 seconds before cleanup
      });
    });

  } catch (error) {
    console.error('Instagram indirme hatası:', error);
    // Clean up on error
    if (timestampDir) {
      fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Video indirilemedi';
    res.status(500).json({ error: errorMessage });
  }
});

// YouTube video indirme endpoint'i
app.post('/api/download/youtube', async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
  let timestampDir: string = '';
  
  try {
    console.log('YouTube endpoint başlatıldı');
    console.log('Request body:', req.body);
    
    // Create downloads directory path
    const downloadsPath = path.join(process.cwd(), 'downloads', Date.now().toString());
    timestampDir = downloadsPath;
    console.log('YouTube Downloads directory path:', timestampDir);
  
    const { url, format } = req.body;

    // Input validation
    if (!url || !format) {
      return res.status(400).json({ error: 'URL ve format gerekli' });
    }

    // Platform kontrolü
    const platform = checkPlatform(url);
    if (platform !== 'youtube') {
      return res.status(400).json({ error: 'Lütfen geçerli bir YouTube URL\'si girin' });
    }

    console.log('YouTube URL işleniyor:', url, 'Format:', format);

    if (!fs.existsSync(timestampDir)) {
      fs.mkdirSync(timestampDir, { recursive: true });
    }

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
      audioQuality: 0, // En yüksek ses kalitesi (0 = en iyi)
      format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio', // En iyi ses formatı
      addMetadata: true,
      noCheckCertificate: true,
      noWarnings: true,
      ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {})
    } : {
      output: outputPath,
      format: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]/bestvideo+bestaudio/best', // 4K'ya kadar destekle
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
        download.stdout.on('data', (data) => {
          const output = data.toString();
          const progressMatch = output.match(/(\d+\.\d+)%/);
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
        download.stdout.on('data', (data) => {
          const output = data.toString();
          const progressMatch = output.match(/(\d+\.\d+)%/);
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

    console.log('YouTube işlem tamamlandı:', fileName);

    // Return success response with download URL
    res.json({ 
      success: true, 
      fileName, 
      downloadUrl: `/api/download/${fileName}`,
      message: 'Video başarıyla işlendi (En yüksek kalite)' 
    });

    // Create download endpoint for this file
    const currentTimestampDir = timestampDir; // Capture for closure
    app.get(`/api/download/${fileName}`, (req: Request, res: Response) => {
      if (!fs.existsSync(outputPath)) {
        return res.status(404).json({ error: 'Dosya bulunamadı' });
      }

      res.download(outputPath, fileName, (err: Error | null) => {
        if (err) {
          console.error('Dosya gönderme hatası:', err);
        }
        // Clean up after download
        setTimeout(() => {
          fs.rm(currentTimestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
            if (rmErr) {
              console.error('Dizin silme hatası:', rmErr);
            }
          });
        }, 5000); // Wait 5 seconds before cleanup
      });
    });

  } catch (error) {
    console.error('YouTube indirme hatası:', error);
    // Clean up on error
    if (timestampDir) {
      fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Video indirilemedi';
    res.status(500).json({ error: errorMessage });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 