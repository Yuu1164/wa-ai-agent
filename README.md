# wa-ai-agent

AI Agent WhatsApp berbasis Node.js yang menggunakan **Baileys** (Pairing Code), **Gemini API**, **TiDB Serverless** sebagai penyimpanan sesi & memori percakapan, serta fitur **Pembuat Stiker** otomatis.

## Fitur Utama

- **WhatsApp Baileys (Pairing Code)**: Terhubung ke WhatsApp tanpa perlu scan QR Code secara manual.
- **Otak AI (Gemini API)**: Menggunakan model Gemini untuk membalas pesan secara kontekstual.
- **Memori Percakapan & Auth State di TiDB Serverless**: Menyimpan kredensial sesi Baileys (`baileys_auth_state`) dan riwayat pesan terakhir (`MEMORY_LIMIT`) di database TiDB Serverless (MySQL-compatible).
- **Pembuat Stiker**: Konversi media menjadi stiker WhatsApp menggunakan `ffmpeg-static` dan `node-webpmux`.
- **HTTP Health Check Server**: Endpoint HTTP bawaan (default port `7860`) untuk kebutuhan monitoring atau deployment di platform seperti Hugging Face Spaces.
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
├── .env.example           # Contoh konfigurasi environment variable
├── Dockerfile             # Konfigurasi container Docker
├── package.json
└── README.md
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

Project ini sudah menyertakan `Dockerfile` dan secara default menggunakan port `7860` (kompatibel dengan Hugging Face Spaces):

```bash
docker build -t wa-ai-agent .
docker run -p 7860:7860 --env-file .env wa-ai-agent
```
