import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import youtubedl from 'youtube-dl-exec';
import instagramGetUrl from 'instagram-url-direct';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from 'ffmpeg-static';
import axios from 'axios';
import fluentFfmpeg from 'fluent-ffmpeg';
es{
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

app.use(express.json());

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

    // Platform kontrolü
    const platform = checkPlatform(url);
    if (platform !== 'instagram') {
      return res.status(400).json({ error: 'Lütfen geçerli bir Instagram URL\'si girin' });
    }

    if (!fs.existsSync(timestampDir)) {
      fs.mkdirSync(timestampDir, { recursive: true });
    }

    const result = await instagramGetUrl(url);
    if (!result.url_list?.[0]) {
      throw new Error('Video URL bulunamadı');
    }

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const filePath = path.join(timestampDir, fileName);
    const tempFilePath = path.join(timestampDir, 'temp.mp4');

    // Önce videoyu indir
    const response = await axios({
      method: 'GET',
      url: result.url_list[0],
      responseType: 'stream',
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
      res.download(filePath, fileName, (err: Error | null) => {
        if (err) {
          console.error('Dosya gönderme hatası:', err);
        }
        // İndirme tamamlandıktan sonra temizlik yap
        fs.rm(timestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
          if (rmErr) {
            console.error('Dizin silme hatası:', rmErr);
          }
        });
      });
    });

  } catch (error) {
    console.error('Instagram indirme hatası:', error);
    // Hata durumunda da temizlik yap
    fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: 'Video indirilemedi' });
  }
});

// YouTube video indirme endpoint'i
app.post('/api/download/youtube', async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
  const timestampDir = path.join(__dirname, '../downloads', Date.now().toString());
  
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
      addMetadata: true,
      noCheckCertificate: true,
      quiet: false,
      progress: true,
      ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {})
    } : {
      output: outputPath,
      format: 'best',
      addMetadata: true,
      noCheckCertificate: true,
      quiet: false,
      progress: true,
      ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {})
    };

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
        format: format === 'audio' ? 'bestaudio' : 'best'
      };
      
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

    res.write(JSON.stringify({ progress: 100, status: 'completed', fileName }) + '\n');
    res.end();

    // İndirme tamamlandıktan sonra dosyayı gönder
    app.get(`/api/download/${fileName}`, (req: Request, res: Response) => {
      res.download(outputPath, fileName, (err: Error | null) => {
        if (err) {
          console.error('Dosya gönderme hatası:', err);
        }
        // İndirme tamamlandıktan sonra temizlik yap
        fs.rm(timestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
          if (rmErr) {
            console.error('Dizin silme hatası:', rmErr);
          }
        });
      });
    });

  } catch (error) {
    console.error('YouTube indirme hatası:', error);
    // Hata durumunda da temizlik yap
    fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: 'Video indirilemedi' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 