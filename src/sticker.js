const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');
const Webp = require('node-webpmux');

// Nama Pack & Author stiker (bisa diubah lewat Environment Variables kapan saja)
const STICKER_PACK_NAME = process.env.STICKER_PACK_NAME || 'Inventory Random';
const STICKER_AUTHOR = process.env.STICKER_AUTHOR || 'BotPromeks';

// Batas aman ukuran stiker animasi WhatsApp (500 KB)
const MAX_ANIMATED_WEBP_BYTES = 500 * 1024;

/**
 * Menjalankan binary ffmpeg-static dengan optimasi ramah CPU container kecil.
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error('Binary ffmpeg-static tidak ditemukan.'));
    }

    execFile(
      ffmpegPath,
      args,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          return reject(new Error(`FFmpeg error: ${stderr || error.message}`));
        }
        resolve();
      }
    );
  });
}

/**
 * Menyisipkan metadata EXIF resmi WhatsApp (Nama Pack & Author) ke file WebP.
 */
async function attachStickerExif(webpBuffer, packName = STICKER_PACK_NAME, author = STICKER_AUTHOR) {
  const img = new Webp.Image();
  await img.load(webpBuffer);

  const exifData = {
    'sticker-pack-id': 'com.botpromeks.inventoryrandom',
    'sticker-pack-name': packName,
    'sticker-pack-publisher': author,
    emojis: ['✨'],
  };

  // Header biner standar TIFF/EXIF WhatsApp (panjang 22 byte / 0x16)
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);

  const jsonBuffer = Buffer.from(JSON.stringify(exifData), 'utf-8');
  const fullExif = Buffer.concat([exifHeader, jsonBuffer]);
  // Tulis panjang payload JSON di byte ke-14 (little-endian 32-bit unsigned int)
  fullExif.writeUIntLE(jsonBuffer.length, 14, 4);

  img.exif = fullExif;
  return img.save(null);
}

/**
 * Mengonversi buffer gambar (PNG/JPG/WebP) atau GIF/video pendek menjadi buffer Stiker WebP WhatsApp.
 */
async function createWhatsAppSticker(mediaBuffer, { isAnimated = false, inputExt = 'bin' } = {}) {
  const uniqueId = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `stiker_in_${uniqueId}.${inputExt}`);
  const outputPath = path.join(tmpDir, `stiker_out_${uniqueId}.webp`);

  try {
    // Simpan media sementara ke /tmp agar FFmpeg bisa membacanya
    await fs.writeFile(inputPath, mediaBuffer);

    if (isAnimated) {
      // Konversi GIF/MP4 -> stiker animasi WebP 512x512 (maksimal 6 detik, 12 fps, 1 thread agar tidak macet)
      await runFfmpeg([
        '-nostdin',
        '-y',
        '-loglevel', 'error',
        '-threads', '1',
        '-i', inputPath,
        '-t', '6',
        '-vcodec', 'libwebp',
        '-vf', 'fps=12,scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
        '-loop', '0',
        '-preset', 'default',
        '-compression_level', '2',
        '-an',
        '-fps_mode', 'vfr',
        '-q:v', '50',
        outputPath,
      ]);

      let webpBuffer = await fs.readFile(outputPath);

      // Jika ukuran stiker animasi melebihi 500 KB, kompres otomatis agar pasti diterima WhatsApp
      if (webpBuffer.length > MAX_ANIMATED_WEBP_BYTES) {
        await runFfmpeg([
          '-nostdin',
          '-y',
          '-loglevel', 'error',
          '-threads', '1',
          '-i', inputPath,
          '-t', '5',
          '-vcodec', 'libwebp',
          '-vf', 'fps=10,scale=320:320:force_original_aspect_ratio=decrease,format=rgba,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=#00000000',
          '-loop', '0',
          '-preset', 'default',
          '-compression_level', '2',
          '-an',
          '-fps_mode', 'vfr',
          '-q:v', '35',
          outputPath,
        ]);
        webpBuffer = await fs.readFile(outputPath);
      }

      return await attachStickerExif(webpBuffer);
    } else {
      // Konversi PNG/JPG/WebP -> stiker statis 512x512 (1 frame, 1 thread, cepat & menjaga transparansi PNG)
      await runFfmpeg([
        '-nostdin',
        '-y',
        '-loglevel', 'error',
        '-threads', '1',
        '-i', inputPath,
        '-frames:v', '1',
        '-vcodec', 'libwebp',
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
        '-lossless', '0',
        '-compression_level', '3',
        '-q:v', '75',
        '-an',
        outputPath,
      ]);

      const webpBuffer = await fs.readFile(outputPath);
      return await attachStickerExif(webpBuffer);
    }
  } finally {
    // Selalu hapus file sementara di /tmp agar penyimpanan server tidak pernah penuh
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

module.exports = {
  createWhatsAppSticker,
};