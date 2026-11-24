# wa-ai-agent

AI Agent WhatsApp berbasis Node.js yang menggunakan **Baileys** (Pairing Code), **Gemini API**, **TiDB Serverless** sebagai penyimpanan sesi & memori percakapan, serta fitur **Pembuat Stiker** otomatis.

## Fitur Utama

- **WhatsApp Baileys (Pairing Code)**: Terhubung ke WhatsApp tanpa perlu scan QR Code secara manual.
- **Otak AI (Gemini API)**: Menggunakan model Gemini untuk membalas pesan secara kontekstual.
- **Memori Percakapan & Auth State di TiDB Serverless**: Menyimpan kredensial sesi Baileys (`baileys_auth_state`) dan riwayat pesan terakhir (`MEMORY_LIMIT`) di database TiDB Serverless (MySQL-compatible).
- **Pembuat Stiker**: Konversi gambar (PNG/JPG/WebP) atau GIF/video pendek menjadi stiker WhatsApp menggunakan `ffmpeg-static` dan `node-webpmux`.
- **HTTP Health Check Server**: Endpoint HTTP bawaan (default port `7860`) untuk kebutuhan monitoring status bot.
- **Siap Docker**: Dilengkapi `Dockerfile` untuk kemudahan deployment.

## Prasyarat

- **Node.js** `>= 20.0.0`
- Akun & cluster **TiDB Serverless**
- **Gemini API Key** dari Google AI Studio
- Nomor WhatsApp aktif untuk bot (format internasional tanpa `+`, contoh: `6281234567890`)

## Struktur Proyek

```text
wa-bot/
├── src/
│   ├── db.js              # Koneksi database TiDB Serverless
│   ├── gemini.js          # Integrasi Gemini API
│   ├── index.js           # Entry point bot & HTTP health check server
│   ├── memory.js          # Manajemen memori percakapan
│   ├── sticker.js         # Pembuat stiker WhatsApp
│   └── tidbAuthState.js   # Penyimpanan auth state Baileys di TiDB
├── .dockerignore          # Daftar file yang diabaikan saat build Docker
├── .env.example           # Contoh konfigurasi environment variable
├── Dockerfile             # Konfigurasi container Docker
├── LICENSE                # Lisensi proyek (MIT)
├── package.json
└── README.md
```

## Skema Database (TiDB Serverless)

Jalankan query SQL berikut pada database TiDB Serverless kamu (sesuai nilai `TIDB_DATABASE` di `.env`) sebelum menjalankan bot untuk pertama kali:

```sql
CREATE DATABASE IF NOT EXISTS wa_ai_bot;
USE wa_ai_bot;

-- Tabel untuk menyimpan sesi & kunci enkripsi Baileys
CREATE TABLE IF NOT EXISTS baileys_auth_state (
  session_id VARCHAR(100) NOT NULL,
  data_key VARCHAR(255) NOT NULL,
  data_value LONGTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, data_key)
);

-- Tabel untuk menyimpan memori percakapan per DM / Grup
CREATE TABLE IF NOT EXISTS chat_memory (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_jid VARCHAR(128) NOT NULL,
  sender_name VARCHAR(120) NOT NULL,
  role ENUM('user', 'model') NOT NULL,
  message_text MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_memory_jid_created (chat_jid, created_at, id)
);
```

## Instalasi & Menjalankan Secara Lokal

1. **Clone repositori**
   ```bash
   git clone https://github.com/Yuu1164/wa-ai-agent.git
   cd wa-ai-agent
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Konfigurasi Environment Variables**
   Salin `.env.example` menjadi `.env`:
   ```bash
   cp .env.example .env
   ```
   Lalu isi variabel berikut di dalam `.env`:
   - `TIDB_HOST`, `TIDB_PORT`, `TIDB_USER`, `TIDB_PASSWORD`, `TIDB_DATABASE` — Kredensial TiDB Serverless.
   - `GEMINI_API_KEY`, `GEMINI_MODEL` — API Key dan model Gemini yang digunakan.
   - `BOT_PHONE_NUMBER` — Nomor WhatsApp bot (tanpa `+`, spasi, atau tanda hubung).
   - `SESSION_ID` — Nama sesi di tabel `baileys_auth_state`.
   - `MEMORY_LIMIT` — Jumlah pesan terakhir yang dikirim ke AI sebagai konteks.
   - `PORT` — Port HTTP health check server (default `7860`).

4. **Jalankan bot**
   ```bash
   npm start
   ```
   Ikuti instruksi pairing code yang muncul di terminal untuk menautkan perangkat WhatsApp.

## Deployment (Docker)

Project ini sudah menyertakan `Dockerfile` dan secara default menggunakan port `7860`:

```bash
docker build -t wa-ai-agent .
docker run -p 7860:7860 --env-file .env wa-ai-agent
```

## Lisensi

Proyek ini dilisensikan di bawah [MIT License](LICENSE).
