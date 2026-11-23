// Memuat file .env jika dijalankan di komputer lokal atau Oracle Cloud VPS
// (Di Hugging Face Spaces, variabel otomatis dibaca dari menu Secrets)
require('dotenv').config();

const http = require('http');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

const { testDbConnection } = require('./db');
const { useTiDBAuthState } = require('./tidbAuthState');
const { getRecentMessages, saveMessage, clearChatMemory } = require('./memory');
const { askGemini } = require('./gemini');

// --- Konfigurasi Dasar ---
const PORT = Number(process.env.PORT || 7860);
const SESSION_ID = process.env.SESSION_ID || 'bot_utama';
const BOT_PHONE_NUMBER = (process.env.BOT_PHONE_NUMBER || '').replace(/[^0-9]/g, '');

// Status global untuk ditampilkan di halaman health-check HTTP (port 7860)
const botStatus = {
  whatsapp: 'starting',
  startedAt: new Date().toISOString(),
  lastConnectedAt: null,
};

// Penanda agar tidak meminta Pairing Code berulang kali secara bersamaan
let isRequestingPairing = false;
// Mencatat waktu mulai bot agar tidak membalas pesan-pesan lama sebelum bot nyala
const botStartTimestampSec = Math.floor(Date.now() / 1000);

/**
 * 1. Menjalankan Server HTTP Mini di Port 7860
 *    Wajib ada untuk Hugging Face Spaces & ping UptimeRobot setiap 5 menit agar tidak sleep.
 */
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'wa-ai-agent',
          whatsapp: botStatus.whatsapp,
          startedAt: botStatus.startedAt,
          lastConnectedAt: botStatus.lastConnectedAt,
          uptimeSeconds: Math.floor(process.uptime()),
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Bind ke 0.0.0.0 agar dapat diakses oleh router container Hugging Face maupun VPS
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Server health-check aktif di http://0.0.0.0:${PORT}`);
  });
}

/**
 * 2. Helper untuk mengekstrak teks dari berbagai tipe pesan WhatsApp
 */
function extractMessageText(message) {
  if (!message) return '';

  // Buka pembungkus pesan sementara (ephemeral / viewOnce) jika ada
  const unwrapped =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;

  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    ''
  ).trim();
}

/**
 * 3. Helper untuk mengecek apakah pesan di dalam grup memicu bot (@bot, tag nomor bot, atau /ai)
 */
function parseGroupTrigger(rawText, message, sock) {
  const botNumber = (sock.user?.id || '').split(':')[0].split('@')[0];
  const botLid = (sock.user?.lid || '').split(':')[0].split('@')[0];

  const contextInfo =
    message.extendedTextMessage?.contextInfo ||
    message.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
    {};
  const mentionedJids = contextInfo.mentionedJid || [];

  const hasPrefixAi = /^\/ai(\s|$)/i.test(rawText);
  const hasTextMentionBot = /(^|\s)@bot(\b|$)/i.test(rawText);
  const hasNativeMention = mentionedJids.some(
    (jid) =>
      (botNumber && jid.startsWith(botNumber)) ||
      (botLid && jid.startsWith(botLid))
  );

  const isTriggered = hasPrefixAi || hasTextMentionBot || hasNativeMention;
  if (!isTriggered) {
    return { triggered: false, cleanPrompt: '' };
  }

  // Bersihkan prefix '/ai', '@bot', dan '@nomor_bot' agar Gemini hanya membaca inti pertanyaan
  let cleanPrompt = rawText
    .replace(/^\/ai\b/i, '')
    .replace(/@bot\b/gi, '');

  if (botNumber) {
    cleanPrompt = cleanPrompt.replace(new RegExp(`@${botNumber}\\b`, 'g'), '');
  }
  if (botLid) {
    cleanPrompt = cleanPrompt.replace(new RegExp(`@${botLid}\\b`, 'g'), '');
  }

  return {
    triggered: true,
    cleanPrompt: cleanPrompt.trim(),
  };
}

/**
 * 4. Fungsi Utama untuk Menjalankan Koneksi WhatsApp Baileys
 */
async function startWhatsAppBot() {
  botStatus.whatsapp = 'connecting';

  // Muat sesi autentikasi dari TiDB Serverless
  const { state, saveCreds, clearSession } = await useTiDBAuthState(SESSION_ID);

  // Ambil versi protokol WhatsApp Web terbaru agar tidak ditolak server WhatsApp
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WA] Menggunakan protokol Baileys WA Web versi: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    // Format browser standar Ubuntu Chrome sangat disarankan untuk Pairing Code 8 digit
    browser: Browsers.ubuntu('Chrome'),
    // Matikan QR Code karena kita wajib menggunakan Pairing Code 8 digit
    printQRInTerminal: false,
    // Log level 'silent' agar terminal/log Hugging Face bersih dan mudah membaca Pairing Code
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // Simpan otomatis setiap kali kredensial Baileys berubah
  sock.ev.on('creds.update', saveCreds);

  // Jika sesi di TiDB belum terdaftar (belum pernah login), minta Pairing Code 8 digit
  if (!state.creds.registered && !isRequestingPairing) {
    if (!BOT_PHONE_NUMBER) {
      console.error(
        '[PAIRING] ERROR: BOT_PHONE_NUMBER belum diisi di Secrets/Env! Contoh: 6281234567890'
      );
    } else {
      isRequestingPairing = true;
      console.log(`[PAIRING] Menyiapkan Pairing Code 8 digit untuk nomor ${BOT_PHONE_NUMBER}...`);

      // Tunggu 3 detik agar soket WebSocket WhatsApp siap menerima permintaan pairing
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
          const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

          console.log('\n======================================================');
          console.log('  KODE PAIRING WHATSAPP (8 DIGIT):', formattedCode);
          console.log('  Buka WhatsApp di HP Tumbal -> Perangkat Tertaut');
          console.log('  -> Tautkan Perangkat -> Tautkan dengan nomor telepon');
          console.log('======================================================\n');
          botStatus.whatsapp = 'awaiting_pairing';
        } catch (err) {
          console.error('[PAIRING] Gagal meminta Pairing Code:', err.message);
        } finally {
          isRequestingPairing = false;
        }
      }, 3000);
    }
  }

  // Pantau status koneksi WhatsApp (Terhubung / Terputus / Logout)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      botStatus.whatsapp = 'connected';
      botStatus.lastConnectedAt = new Date().toISOString();
      console.log(`[WA] Terhubung sukses sebagai: ${sock.user?.id}`);
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      botStatus.whatsapp = isLoggedOut ? 'logged_out' : 'disconnected';
      console.warn(`[WA] Koneksi terputus (kode: ${statusCode}). LoggedOut: ${isLoggedOut}`);

      if (isLoggedOut) {
        // Jika nomor dilepas dari menu Perangkat Tertaut HP, hapus sesi lama di TiDB lalu pairing ulang
        console.log('[WA] Sesi dicabut oleh WhatsApp. Membersihkan sesi di TiDB untuk pairing baru...');
        await clearSession();
        setTimeout(() => startWhatsAppBot(), 5000);
      } else {
        // Gangguan jaringan sementara / restart: otomatis sambungkan ulang dalam 5 detik
        console.log('[WA] Mencoba menyambungkan ulang dalam 5 detik...');
        setTimeout(() => startWhatsAppBot(), 5000);
      }
    }
  });

  // Tangani setiap pesan baru yang masuk (DM Pribadi maupun Grup)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Hanya proses pesan baru real-time, bukan riwayat sinkronisasi lama
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue; // Abaikan pesan yang dikirim oleh bot sendiri

        const chatJid = msg.key.remoteJid;
        if (!chatJid || chatJid === 'status@broadcast') continue;

        // Abaikan pesan lama (> 2 menit sebelum bot menyala) agar tidak spam saat baru start
        const msgTimestamp = Number(msg.messageTimestamp || 0);
        if (msgTimestamp > 0 && msgTimestamp < botStartTimestampSec - 120) {
          continue;
        }

        const rawText = extractMessageText(msg.message);
        if (!rawText) continue;

        const isGroup = chatJid.endsWith('@g.us');
        const senderName = msg.pushName || 'Pengguna';
        let promptText = rawText;

        // --- Aturan Grup vs DM Pribadi ---
        if (isGroup) {
          const parsed = parseGroupTrigger(rawText, msg.message, sock);
          // Jika di dalam grup dan tidak menyebut @bot / tag bot / /ai, abaikan!
          if (!parsed.triggered) continue;

          promptText = parsed.cleanPrompt;
          if (!promptText) {
            await sock.sendMessage(
              chatJid,
              { text: 'Halo! Di dalam grup, gunakan `/ai <pertanyaan>` atau mention `@bot <pertanyaan>` ya.' },
              { quoted: msg }
            );
            continue;
          }
        }

        // --- Perintah Bonus: Reset Memori Percakapan (/reset) ---
        if (/^\/?reset$/i.test(promptText)) {
          await clearChatMemory(chatJid);
          await sock.sendMessage(
            chatJid,
            { text: 'Memori percakapan untuk obrolan ini sudah dibersihkan. Yuk mulai topik baru!' },
            { quoted: msg }
          );
          continue;
        }

        console.log(`[MSG] ${isGroup ? 'GRUP' : 'DM'} | ${senderName}: ${promptText}`);

        // Tampilkan status "mengetik..." di WhatsApp agar respons terasa interaktif
        await sock.sendPresenceUpdate('composing', chatJid);

        // 1. Ambil 5-8 pesan terakhir dari TiDB sebagai konteks obrolan
        const historyRows = await getRecentMessages(chatJid);

        // 2. Kirim konteks + pesan baru ke otak AI Gemini
        const aiReply = await askGemini({
          historyRows,
          senderName,
          userMessage: promptText,
          isGroup,
        });

        // 3. Simpan pesan pengguna & balasan AI ke memori TiDB secara berurutan
        await saveMessage(chatJid, senderName, 'user', promptText);
        await saveMessage(chatJid, 'AI Bot', 'model', aiReply);

        // 4. Kirim balasan ke WhatsApp (di grup menggunakan reply/quoted agar rapi)
        await sock.sendMessage(
          chatJid,
          { text: aiReply },
          isGroup ? { quoted: msg } : undefined
        );

        await sock.sendPresenceUpdate('paused', chatJid);
      } catch (err) {
        console.error('[MSG] Gagal memproses pesan:', err);
        const chatJid = msg.key?.remoteJid;
        if (chatJid) {
          await sock
            .sendMessage(
              chatJid,
              { text: 'Maaf, otak AI sedang mengalami kendala sementara. Coba kirim ulang sebentar lagi ya.' },
              { quoted: msg }
            )
            .catch(() => {});
        }
      }
    }
  });
}

/**
 * 5. Titik Masuk Utama Aplikasi (Bootstrap)
 */
async function main() {
  // Nyalakan server HTTP port 7860 terlebih dahulu agar Hugging Face tahu container sehat
  startHealthServer();

  // Pastikan database TiDB Serverless siap sebelum menyalakan WhatsApp
  await testDbConnection();

  // Mulai bot WhatsApp Baileys
  await startWhatsAppBot();
}

// Tangkap error tak terduga agar proses Node.js tidak mati mendadak tanpa jejak di log
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[PROCESS] Uncaught Exception:', error);
});

main().catch((err) => {
  console.error('[FATAL] Gagal menjalankan aplikasi:', err);
  process.exit(1);
});
