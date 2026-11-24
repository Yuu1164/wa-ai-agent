// Memuat file .env jika dijalankan di komputer lokal atau Oracle Cloud VPS
require('dotenv').config();

const http = require('http');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { testDbConnection } = require('./db');
const { useTiDBAuthState } = require('./tidbAuthState');
const { getRecentMessages, saveMessage, clearChatMemory } = require('./memory');
const { askGemini } = require('./gemini');
const { createWhatsAppSticker } = require('./sticker');

// --- Konfigurasi Dasar ---
const PORT = Number(process.env.PORT || 7860);
const SESSION_ID = process.env.SESSION_ID || 'bot_utama';
const BOT_PHONE_NUMBER = (process.env.BOT_PHONE_NUMBER || '').replace(/[^0-9]/g, '');

// Logger silent untuk Baileys agar log server tetap bersih
const baileysLogger = pino({ level: 'silent' });

// Status global untuk ditampilkan di halaman health-check HTTP
const botStatus = {
  whatsapp: 'starting',
  startedAt: new Date().toISOString(),
  lastConnectedAt: null,
};

let isRequestingPairing = false;
const botStartTimestampSec = Math.floor(Date.now() / 1000);

/**
 * 1. Menjalankan Server HTTP Mini (untuk Health-Check & UptimeRobot)
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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Server health-check aktif di http://0.0.0.0:${PORT}`);
  });
}

/**
 * 2. Membuka semua lapisan pembungkus pesan WhatsApp (ephemeral, viewOnce, documentWithCaption, dll.)
 */
function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 5; i++) {
    if (!current) break;
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else if (current.editedMessage?.message) {
      current = current.editedMessage.message;
    } else {
      break;
    }
  }
  return current || {};
}

/**
 * 3. Mengekstrak teks atau caption dari pesan yang sudah di-unwrap
 */
function extractMessageText(unwrapped) {
  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    unwrapped.documentMessage?.caption ||
    ''
  ).trim();
}

/**
 * 4. Mengekstrak contextInfo (berisi daftar mention & pesan yang di-reply)
 */
function extractContextInfo(unwrapped) {
  return (
    unwrapped.extendedTextMessage?.contextInfo ||
    unwrapped.imageMessage?.contextInfo ||
    unwrapped.videoMessage?.contextInfo ||
    unwrapped.documentMessage?.contextInfo ||
    unwrapped.audioMessage?.contextInfo ||
    unwrapped.stickerMessage?.contextInfo ||
    {}
  );
}

/**
 * 5. Mengambil angka ID bersih dari JID WhatsApp (baik format 628xxx:12@s.whatsapp.net maupun 12345:12@lid)
 */
function normalizeJidUser(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0].trim();
}

/**
 * 6. Mengumpulkan semua identitas bot (Nomor HP & LID WhatsApp Business) untuk mencocokkan mention grup
 */
function getBotIdentifiers(sock) {
  const candidates = [
    BOT_PHONE_NUMBER,
    normalizeJidUser(sock.user?.id),
    normalizeJidUser(sock.user?.lid),
    normalizeJidUser(sock.authState?.creds?.me?.id),
    normalizeJidUser(sock.authState?.creds?.me?.lid),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

/**
 * 7. Mendeteksi media yang bisa dijadikan stiker (PNG/JPG/WebP/GIF/Video pendek/Dokumen PNG-GIF)
 */
function detectStickerMedia(unwrapped) {
  if (unwrapped.imageMessage) {
    const mime = unwrapped.imageMessage.mimetype || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return { isAnimated: false, inputExt: ext, seconds: 0 };
  }

  if (unwrapped.videoMessage) {
    return {
      isAnimated: true,
      inputExt: 'mp4',
      seconds: Number(unwrapped.videoMessage.seconds || 0),
    };
  }

  if (unwrapped.documentMessage) {
    const mime = (unwrapped.documentMessage.mimetype || '').toLowerCase();
    if (mime.startsWith('image/gif')) {
      return { isAnimated: true, inputExt: 'gif', seconds: 0 };
    }
    if (mime.startsWith('image/')) {
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      return { isAnimated: false, inputExt: ext, seconds: 0 };
    }
    if (mime.startsWith('video/')) {
      return { isAnimated: true, inputExt: 'mp4', seconds: 0 };
    }
  }

  return null;
}

/**
 * 8. Menangani perintah /gif (kirim langsung dengan caption /gif ATAU reply media dengan /gif)
 */
async function handleStickerCommand(sock, msg, unwrapped, contextInfo, chatJid) {
  // Cek apakah pesan saat ini mengandung media langsung
  let mediaInfo = detectStickerMedia(unwrapped);
  let targetDownloadMsg = msg;

  // Jika tidak ada media di pesan utama, cek apakah user sedang me-reply sebuah gambar/GIF
  if (!mediaInfo && contextInfo.quotedMessage) {
    const unwrappedQuoted = unwrapMessage(contextInfo.quotedMessage);
    mediaInfo = detectStickerMedia(unwrappedQuoted);
    if (mediaInfo) {
      targetDownloadMsg = {
        key: {
          remoteJid: chatJid,
          id: contextInfo.stanzaId || msg.key.id,
          participant: contextInfo.participant,
        },
        message: contextInfo.quotedMessage,
      };
    }
  }

  if (!mediaInfo) {
    await sock.sendMessage(
      chatJid,
      {
        text:
          'Cara pakai */gif*:\n' +
          '1. Kirim gambar (PNG/JPG) atau GIF/video pendek dengan caption `/gif`, *atau*\n' +
          '2. *Reply* gambar/GIF yang sudah ada di chat lalu ketik `/gif`.',
      },
      { quoted: msg }
    );
    return;
  }

  // Batasi video yang terlalu panjang (> 30 detik) agar tidak boros RAM & bandwidth server gratis
  if (mediaInfo.seconds > 30) {
    await sock.sendMessage(
      chatJid,
      { text: 'Video terlalu panjang (maksimal 30 detik). Kirim GIF atau video pendek ya!' },
      { quoted: msg }
    );
    return;
  }

  await sock.sendPresenceUpdate('composing', chatJid);

  // Unduh media dari server WhatsApp menjadi Buffer
  const mediaBuffer = await downloadMediaMessage(
    targetDownloadMsg,
    'buffer',
    {},
    {
      logger: baileysLogger,
      reuploadRequest: sock.updateMediaMessage,
    }
  );

  // Konversi menjadi stiker WebP 512x512 dengan nama pack "Inventory Random"
  const stickerBuffer = await createWhatsAppSticker(mediaBuffer, {
    isAnimated: mediaInfo.isAnimated,
    inputExt: mediaInfo.inputExt,
  });

  await sock.sendMessage(chatJid, { sticker: stickerBuffer }, { quoted: msg });
  await sock.sendPresenceUpdate('paused', chatJid);
}

/**
 * 9. Mengecek apakah pesan di dalam grup memicu bot:
 *    - Prefix /ai
 *    - Teks @bot atau @BotPromeks
 *    - Mention resmi WhatsApp (baik nomor 628xxx maupun @lid)
 *    - Reply langsung ke pesan yang dikirim oleh bot
 */
function parseGroupTrigger(rawText, contextInfo, sock) {
  const botIds = getBotIdentifiers(sock);
  const mentionedJids = contextInfo.mentionedJid || [];
  const quotedParticipant = normalizeJidUser(contextInfo.participant);

  const hasPrefixAi = /^\/ai(\s|$)/i.test(rawText);
  const hasTextMentionBot = /(^|\s)@(bot|botpromeks)(\b|$)/i.test(rawText);

  const matchedMentionIds = mentionedJids
    .map((jid) => normalizeJidUser(jid))
    .filter((id) => id && botIds.includes(id));

  const hasNativeMention = matchedMentionIds.length > 0;
  const isReplyingToBot = Boolean(quotedParticipant && botIds.includes(quotedParticipant));

  const isTriggered = hasPrefixAi || hasTextMentionBot || hasNativeMention || isReplyingToBot;

  if (!isTriggered) {
    return { triggered: false, cleanPrompt: '', botIds, mentionedJids };
  }

  // Bersihkan prefix /ai, @bot, @BotPromeks, serta tag angka @nomor / @lid milik bot
  let cleanPrompt = rawText
    .replace(/^\/ai\b/i, '')
    .replace(/@(bot|botpromeks)\b/gi, '');

  for (const id of new Set([...botIds, ...matchedMentionIds])) {
    cleanPrompt = cleanPrompt.replace(new RegExp(`@${id}\\b`, 'g'), '');
  }

  return {
    triggered: true,
    cleanPrompt: cleanPrompt.trim(),
    botIds,
    mentionedJids,
  };
}

/**
 * 10. Fungsi Utama untuk Menjalankan Koneksi WhatsApp Baileys
 */
async function startWhatsAppBot() {
  botStatus.whatsapp = 'connecting';

  const { state, saveCreds, clearSession } = await useTiDBAuthState(SESSION_ID);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WA] Menggunakan protokol Baileys WA Web versi: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    logger: baileysLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Jika sesi belum terdaftar di TiDB, minta Pairing Code 8 digit
  if (!state.creds.registered && !isRequestingPairing) {
    if (!BOT_PHONE_NUMBER) {
      console.error(
        '[PAIRING] ERROR: BOT_PHONE_NUMBER belum diisi di Environment Variables! Contoh: 6281234567890'
      );
    } else {
      isRequestingPairing = true;
      console.log(`[PAIRING] Menyiapkan Pairing Code 8 digit untuk nomor ${BOT_PHONE_NUMBER}...`);

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

  // Pantau status koneksi WhatsApp
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      botStatus.whatsapp = 'connected';
      botStatus.lastConnectedAt = new Date().toISOString();
      console.log(
        `[WA] Terhubung sukses! ID: ${sock.user?.id} | LID: ${sock.user?.lid || '-'} | BotIDs: [${getBotIdentifiers(sock).join(', ')}]`
      );
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      botStatus.whatsapp = isLoggedOut ? 'logged_out' : 'disconnected';
      console.warn(`[WA] Koneksi terputus (kode: ${statusCode}). LoggedOut: ${isLoggedOut}`);

      if (isLoggedOut) {
        console.log('[WA] Sesi dicabut oleh WhatsApp. Membersihkan sesi di TiDB untuk pairing baru...');
        await clearSession();
        setTimeout(() => startWhatsAppBot(), 5000);
      } else {
        console.log('[WA] Mencoba menyambungkan ulang dalam 5 detik...');
        setTimeout(() => startWhatsAppBot(), 5000);
      }
    }
  });

  // Tangani setiap pesan baru yang masuk (DM Pribadi maupun Grup)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue; // Abaikan pesan yang dikirim oleh nomor bot sendiri

        const chatJid = msg.key.remoteJid;
        if (!chatJid || chatJid === 'status@broadcast') continue;

        // Abaikan pesan lama (> 2 menit sebelum bot menyala)
        const msgTimestamp = Number(msg.messageTimestamp || 0);
        if (msgTimestamp > 0 && msgTimestamp < botStartTimestampSec - 120) {
          continue;
        }

        const unwrapped = unwrapMessage(msg.message);
        const rawText = extractMessageText(unwrapped);
        if (!rawText) continue;

        const contextInfo = extractContextInfo(unwrapped);
        const isGroup = chatJid.endsWith('@g.us');
        const senderName = msg.pushName || 'Pengguna';

        // --- 1. Perintah Pembuat Stiker (/gif) — aktif di DM maupun Grup tanpa perlu mention ---
        if (/^\/gif(\s|$)/i.test(rawText)) {
          console.log(`[STICKER] ${isGroup ? 'GRUP' : 'DM'} | ${senderName} meminta /gif`);
          await handleStickerCommand(sock, msg, unwrapped, contextInfo, chatJid);
          continue;
        }

        // --- 2. Perintah Menu Bantuan (/menu atau /help) ---
        if (/^\/(menu|help)(\s|$)/i.test(rawText)) {
          await sock.sendMessage(
            chatJid,
            {
              text:
                '*Menu BotPromeks AI*\n\n' +
                '• *Chat AI (DM):* Langsung kirim pesan apa saja\n' +
                '• *Chat AI (Grup):* Pakai `/ai <pertanyaan>`, tag `@BotPromeks`, ketik `@bot`, atau *reply* pesan bot\n' +
                '• *Buat Stiker:* Kirim atau *reply* foto/PNG/GIF dengan caption `/gif` (Pack: _Inventory Random_)\n' +
                '• *Hapus Memori:* Ketik `/reset` (atau `/ai reset` di grup)',
            },
            { quoted: msg }
          );
          continue;
        }

        let promptText = rawText;

        // --- 3. Aturan Trigger Grup vs DM Pribadi ---
        if (isGroup) {
          const parsed = parseGroupTrigger(rawText, contextInfo, sock);
          if (!parsed.triggered) {
            // Log diagnosa singkat agar mudah dicek di Logs Abasthan jika ada format mention baru
            if (rawText.includes('@') || parsed.mentionedJids.length > 0) {
              console.log(
                `[GRUP-DEBUG] Diabaikan | text="${rawText}" | mentioned=[${parsed.mentionedJids.join(', ')}] | botIds=[${parsed.botIds.join(', ')}]`
              );
            }
            continue;
          }

          promptText = parsed.cleanPrompt;
          if (!promptText) {
            await sock.sendMessage(
              chatJid,
              { text: 'Halo! Ketik `/ai <pertanyaan>` atau tag `@BotPromeks <pertanyaan>` ya.' },
              { quoted: msg }
            );
            continue;
          }
        } else {
          // Jika di DM pribadi user mengetik '/ai ...', bersihkan prefix '/ai' agar rapi
          promptText = rawText.replace(/^\/ai\b/i, '').trim() || rawText;
        }

        // --- 4. Perintah Reset Memori Percakapan (/reset) ---
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

        await sock.sendPresenceUpdate('composing', chatJid);

        const historyRows = await getRecentMessages(chatJid);

        const aiReply = await askGemini({
          historyRows,
          senderName,
          userMessage: promptText,
          isGroup,
        });

        await saveMessage(chatJid, senderName, 'user', promptText);
        await saveMessage(chatJid, 'AI Bot', 'model', aiReply);

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
              { text: 'Maaf, terjadi kendala saat memproses permintaanmu. Coba kirim ulang sebentar lagi ya.' },
              { quoted: msg }
            )
            .catch(() => {});
        }
      }
    }
  });
}

/**
 * 11. Titik Masuk Utama Aplikasi
 */
async function main() {
  startHealthServer();
  await testDbConnection();
  await startWhatsAppBot();
}

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