const mysql = require('mysql2/promise');

// Pastikan seluruh variabel database yang wajib sudah terisi sebelum aplikasi berjalan
const requiredEnvVars = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE'];
for (const envName of requiredEnvVars) {
  if (!process.env[envName]) {
    throw new Error(`[DB] Environment variable wajib belum diisi: ${envName}`);
  }
}

// Membuat connection pool ke TiDB Serverless
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: Number(process.env.TIDB_PORT || 4000),
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  // TiDB Serverless mewajibkan koneksi terenkripsi TLS v1.2+
  ssl: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  },
  // Batasi maksimal 5 koneksi paralel agar ramah kuota Free Tier
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  // Menjaga koneksi tetap hangat agar tidak putus saat bot sedang idle
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

/**
 * Menguji apakah koneksi ke TiDB Serverless berhasil saat aplikasi pertama kali menyala.
 */
async function testDbConnection() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    console.log('[DB] Berhasil terhubung ke TiDB Serverless (TLS aktif).');
  } finally {
    connection.release();
  }
}

module.exports = {
  pool,
  testDbConnection,
};
