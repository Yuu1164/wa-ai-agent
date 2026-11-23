const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Default menggunakan gemini-3.5-flash-lite; bisa diganti ke gemini-3.8-flash lewat Secrets
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Instruksi kepribadian & gaya bicara bot di WhatsApp
const SYSTEM_PROMPT = [
  'Kamu adalah asisten AI WhatsApp yang ramah, cerdas, dan ringkas.',
  'Jawab pertanyaan secara langsung, jelas, dan mudah dibaca di layar HP.',
  'Gunakan bahasa Indonesia yang natural (atau ikuti bahasa yang dipakai pengguna).',
  'Jika berada di dalam grup, perhatikan nama pengirim di awal pesan [Nama]: agar kamu tahu siapa yang sedang berbicara.',
  'Hindari format tabel Markdown yang lebar karena sulit dibaca di WhatsApp; gunakan poin singkat jika perlu.',
].join(' ');

/**
 * Menyusun riwayat pesan dari TiDB + pesan terbaru menjadi format `contents` yang valid bagi Gemini API.
 * Gemini mewajibkan percakapan diawali role 'user' dan bergantian antara 'user' dan 'model'.
 */
function buildGeminiContents(historyRows, latestSenderName, latestUserText, isGroup) {
  const rawTurns = [];

  for (const row of historyRows) {
    const formattedText =
      row.role === 'user' && isGroup
        ? `[${row.sender_name}]: ${row.message_text}`
        : row.message_text;

    rawTurns.push({
      role: row.role,
      text: formattedText,
    });
  }

  // Tambahkan pesan terbaru yang barusan dikirim pengguna
  const currentText = isGroup
    ? `[${latestSenderName}]: ${latestUserText}`
    : latestUserText;

  rawTurns.push({
    role: 'user',
    text: currentText,
  });

  // Buang pesan awal jika kebetulan diawali oleh 'model'
  while (rawTurns.length > 0 && rawTurns[0].role !== 'user') {
    rawTurns.shift();
  }

  // Gabungkan pesan berturut-turut dengan role yang sama agar urutan selalu bergantian user <-> model
  const contents = [];
  for (const turn of rawTurns) {
    const lastEntry = contents[contents.length - 1];
    if (lastEntry && lastEntry.role === turn.role) {
      lastEntry.parts[0].text += `\n${turn.text}`;
    } else {
      contents.push({
        role: turn.role,
        parts: [{ text: turn.text }],
      });
    }
  }

  return contents;
}

/**
 * Mengirim percakapan ke Gemini API dan mengembalikan teks jawabannya.
 */
async function askGemini({ historyRows, senderName, userMessage, isGroup }) {
  if (!GEMINI_API_KEY) {
    throw new Error('[GEMINI] GEMINI_API_KEY belum diatur di Environment Variables.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const contents = buildGeminiContents(historyRows, senderName, userMessage, isGroup);

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    // Batas waktu tunggu maksimal 30 detik agar bot tidak macet
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data?.error?.message || `HTTP ${response.status}`;
    console.error(`[GEMINI] Error dari API (model: ${GEMINI_MODEL}):`, errorMsg);
    throw new Error(`Gemini API Error: ${errorMsg}`);
  }

  // Ekstrak teks balasan dari kandidat pertama
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const replyText = parts
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!replyText) {
    return 'Maaf, saya tidak bisa menghasilkan jawaban untuk pesan tersebut.';
  }

  return replyText;
}

module.exports = {
  askGemini,
};
