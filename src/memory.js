const { pool } = require('./db');

// Batas memori default dari Environment Variable (aman di rentang 2 sampai 20 pesan)
const DEFAULT_MEMORY_LIMIT = Math.max(
  2,
  Math.min(20, parseInt(process.env.MEMORY_LIMIT || '6', 10) || 6)
);

/**
 * Mengambil N pesan terakhir untuk sebuah obrolan (grup atau DM) dalam urutan kronologis.
 * @param {string} chatJid - ID unik grup ('...@g.us') atau DM ('...@s.whatsapp.net')
 * @param {number} limit - Jumlah pesan terakhir yang ingin diambil
 */
async function getRecentMessages(chatJid, limit = DEFAULT_MEMORY_LIMIT) {
  // Validasi integer ketat agar aman digunakan langsung di klausa LIMIT TiDB/MySQL
  const safeLimit = Math.max(1, Math.min(20, parseInt(limit, 10) || DEFAULT_MEMORY_LIMIT));

  const [rows] = await pool.execute(
    `SELECT sender_name, role, message_text
     FROM chat_memory
     WHERE chat_jid = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ${safeLimit}`,
    [chatJid]
  );

  // Query mengambil dari terbaru -> terlama, jadi kita balik menjadi terlama -> terbaru
  return rows.reverse();
}

/**
 * Menyimpan satu pesan ke memori percakapan dan otomatis membersihkan pesan yang terlalu lama.
 * @param {string} chatJid - ID obrolan WhatsApp
 * @param {string} senderName - Nama pengirim pesan (atau 'AI Bot' untuk balasan model)
 * @param {'user'|'model'} role - Peran sesuai standar Gemini API
 * @param {string} messageText - Isi teks pesan
 */
async function saveMessage(chatJid, senderName, role, messageText) {
  const safeSender = (senderName || 'User').slice(0, 120);
  const cleanText = String(messageText || '').trim();
  if (!cleanText) return;

  await pool.execute(
    `INSERT INTO chat_memory (chat_jid, sender_name, role, message_text)
     VALUES (?, ?, ?, ?)`,
    [chatJid, safeSender, role, cleanText]
  );

  // Auto-pruning: hanya pertahankan maksimal N pesan terakhir per chat_jid agar DB tetap hemat
  const keepRows = DEFAULT_MEMORY_LIMIT;
  await pool.execute(
    `DELETE FROM chat_memory
     WHERE chat_jid = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id
           FROM chat_memory
           WHERE chat_jid = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ${keepRows}
         ) AS recent_rows
       )`,
    [chatJid, chatJid]
  );
}

/**
 * Menghapus seluruh memori percakapan pada grup/DM tertentu (untuk perintah /reset).
 */
async function clearChatMemory(chatJid) {
  await pool.execute(
    `DELETE FROM chat_memory WHERE chat_jid = ?`,
    [chatJid]
  );
}

module.exports = {
  getRecentMessages,
  saveMessage,
  clearChatMemory,
};
