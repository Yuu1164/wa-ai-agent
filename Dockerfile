# Menggunakan Node.js 22 LTS berbasis Debian Slim (ringan & kompatibel penuh dengan library crypto/TLS)
FROM node:22-slim

# Instal sertifikat SSL (wajib untuk koneksi aman ke TiDB Serverless) dan git (untuk dependensi Baileys)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Tentukan direktori kerja di dalam container
WORKDIR /app

# Salin file daftar library terlebih dahulu (memanfaatkan Docker cache agar build berikutnya lebih cepat)
COPY --chown=node:node package*.json ./

# Instal hanya library yang dibutuhkan untuk produksi (lebih hemat ruang & RAM)
RUN npm install --omit=dev

# Salin seluruh kode sumber proyek dengan kepemilikan user non-root (UID 1000)
COPY --chown=node:node . .

# Beralih ke user non-root (best practice keamanan container)
USER node

# Expose port 7860 untuk endpoint HTTP health-check
EXPOSE 7860

# Jalankan aplikasi bot
CMD ["npm", "start"]
