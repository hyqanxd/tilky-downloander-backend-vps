import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from 'ffmpeg-static';

const execAsync = promisify(exec);

interface DownloadRequest {
  url: string;
  format: 'audio' | 'video';
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// URL'nin hangi platforma ait olduğunu kontrol et
function checkPlatform(url: string): 'youtube' | 'instagram' | 'unsupported' {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  } else if (url.includes('instagram.com')) {
    return 'instagram';
  }
  return 'unsupported';
}

// Rastgele dosya adı oluştur
function generateFileName(extension: string): string {
  const randomNum = Math.floor(Math.random() * 1000000);
  return `tilky-${randomNum}.${extension}`;
}

// Video indirme fonksiyonu
async function downloadVideo(url: string, format: string, outputPath: string): Promise<void> {
  let command = `yt-dlp "${url}" `;
  
  if (format === 'audio') {
    command += `-x --audio-format mp3 --audio-quality 0 `;
    if (ffmpeg) {
      command += `--ffmpeg-location "${ffmpeg}" `;
    }
  } else {
    command += `-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" `;
  }

  command += `--no-warnings --no-check-certificates `;
  command += `-o "${outputPath}" `;
  command += `--progress-template "download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s"`;

  const { stdout, stderr } = await execAsync(command);
  if (stderr) {
    throw new Error(`İndirme hatası: ${stderr}`);
  }
  return;
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

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const outputPath = path.join(timestampDir, fileName);

    // İlerleme durumunu başlat
    res.write(JSON.stringify({ progress: 0, status: 'starting' }) + '\n');

    try {
      await downloadVideo(url, format, outputPath);
      
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
          fs.rm(timestampDir, { recursive: true, force: true }, (rmErr: Error | null) => {
            if (rmErr) {
              console.error('Dizin silme hatası:', rmErr);
            }
          });
        });
      });

    } catch (downloadError) {
      throw new Error(`Video indirilemedi: ${downloadError.message}`);
    }

  } catch (error) {
    console.error('Instagram indirme hatası:', error);
    fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    
    let errorMessage = 'Video indirilemedi';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ error: errorMessage });
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
      format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      addMetadata: true,
      noCheckCertificate: true,
      quiet: false,
      progress: true,
      ...(ffmpeg ? { ffmpegLocation: ffmpeg } : {})
    };

    // İndirme işlemini başlat
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