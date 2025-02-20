import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import ffmpeg from 'ffmpeg-static';
import axios from 'axios';
import fluentFfmpeg from 'fluent-ffmpeg';
import { InstaFetcher } from 'insta-fetcher';

const execAsync = promisify(exec);
const insta = new InstaFetcher();

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
async function downloadVideo(url: string, format: string, outputPath: string, res: Response): Promise<void> {
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
  command += `--newline --progress-template "download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s"`;

  const downloadProcess = exec(command);
  let lastProgress = 0;

  if (downloadProcess.stdout) {
    downloadProcess.stdout.on('data', (data: Buffer) => {
      try {
        const output = data.toString();
        const match = output.match(/download:(\d+)\/(\d+)/);
        if (match) {
          const [, downloaded, total] = match;
          const progress = Math.round((parseInt(downloaded) / parseInt(total)) * 100);
          if (progress > lastProgress) {
            lastProgress = progress;
            res.write(JSON.stringify({ progress, status: 'downloading' }) + '\n');
          }
        }
      } catch (err) {
        // İlerleme bilgisi işlenemezse sessizce devam et
      }
    });
  }

  return new Promise((resolve, reject) => {
    downloadProcess.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`İndirme işlemi başarısız oldu (kod: ${code})`));
      }
    });
    downloadProcess.on('error', reject);
  });
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
      await downloadVideo(url, format, outputPath, res);
      
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
      if (downloadError instanceof Error) {
        throw new Error(`Video indirilemedi: ${downloadError.message}`);
      }
      throw new Error('Video indirilemedi');
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

    const fileName = generateFileName(format === 'audio' ? 'mp3' : 'mp4');
    const outputPath = path.join(timestampDir, fileName);

    // İlerleme durumunu başlat
    res.write(JSON.stringify({ progress: 0, status: 'starting' }) + '\n');

    try {
      await downloadVideo(url, format, outputPath, res);
      
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
      if (downloadError instanceof Error) {
        throw new Error(`Video indirilemedi: ${downloadError.message}`);
      }
      throw new Error('Video indirilemedi');
    }

  } catch (error) {
    console.error('YouTube indirme hatası:', error);
    fs.rm(timestampDir, { recursive: true, force: true }, () => {});
    
    let errorMessage = 'Video indirilemedi';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 