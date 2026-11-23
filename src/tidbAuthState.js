const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { pool } = require('./db');

/**
 * Custom Auth State untuk Baileys yang menyimpan seluruh sesi login ke TiDB Serverless.
 * @param {string} sessionId - Nama unik sesi bot (misalnya 'bot_utama')
 */
async function useTiDBAuthState(sessionId = 'bot_utama') {
  /**
   * Menyimpan atau memperbarui satu kunci data sesi ke tabel baileys_auth_state.
   */
  const writeData = async (key, data) => {
    // BufferJSON.replacer wajib dipakai agar data biner (Buffer) Baileys aman diubah ke JSON
    const jsonValue = JSON.stringify(data, BufferJSON.replacer);
    await pool.execute(
      `INSERT INTO baileys_auth_state (session_id, data_key, data_value)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         data_value = VALUES(data_value),
         updated_at = CURRENT_TIMESTAMP`,
      [sessionId, key, jsonValue]
    );
  };

  /**
   * Membaca satu kunci data sesi dari TiDB.
   */
  const readData = async (key) => {
    const [rows] = await pool.execute(
      `SELECT data_value
       FROM baileys_auth_state
       WHERE session_id = ? AND data_key = ?
       LIMIT 1`,
      [sessionId, key]
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    // BufferJSON.reviver mengembalikan objek JSON menjadi Buffer biner asli Baileys
    return JSON.parse(rows[0].data_value, BufferJSON.reviver);
  };

  /**
   * Menghapus satu kunci data sesi dari TiDB.
   */
  const removeData = async (key) => {
    await pool.execute(
      `DELETE FROM baileys_auth_state
       WHERE session_id = ? AND data_key = ?`,
      [sessionId, key]
    );
  };

  /**
   * Menghapus seluruh sesi milik sessionId ini (dipakai jika nomor di-logout dari HP).
   */
  const clearSession = async () => {
    await pool.execute(
      `DELETE FROM baileys_auth_state WHERE session_id = ?`,
      [sessionId]
    );
    console.log(`[AUTH] Seluruh data sesi '${sessionId}' telah dibersihkan dari TiDB.`);
  };

  // Muat kredensial utama ('creds'). Jika belum ada, buat kredensial baru untuk pairing
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        /**
         * Mengambil banyak kunci sekaligus dalam 1 query SQL (batching)
         * agar latensi ke cloud database tetap cepat.
         */
        get: async (type, ids) => {
          const result = {};
          if (!ids || ids.length === 0) {
            return result;
          }

          const dbKeys = ids.map((id) => `${type}-${id}`);
          const placeholders = dbKeys.map(() => '?').join(', ');

          const [rows] = await pool.execute(
            `SELECT data_key, data_value
             FROM baileys_auth_state
             WHERE session_id = ? AND data_key IN (${placeholders})`,
            [sessionId, ...dbKeys]
          );

          const rowMap = new Map();
          for (const row of rows) {
            rowMap.set(row.data_key, row.data_value);
          }

          for (const id of ids) {
            const rawJson = rowMap.get(`${type}-${id}`);
            if (rawJson) {
              let value = JSON.parse(rawJson, BufferJSON.reviver);
              // Aturan wajib Baileys: khusus app-state-sync-key harus dibungkus ulang ke protobuf
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              result[id] = value;
            }
          }

          return result;
        },

        /**
         * Menyimpan atau menghapus sekumpulan kunci enkripsi saat Baileys bertransaksi pesan.
         */
        set: async (data) => {
          const tasks = [];

          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const dbKey = `${category}-${id}`;

              if (value) {
                tasks.push(writeData(dbKey, value));
              } else {
                tasks.push(removeData(dbKey));
              }
            }
          }

          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    clearSession,
  };
}

module.exports = {
  useTiDBAuthState,
};
