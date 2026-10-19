# ARCHITECTURE SPECIFICATION: FROM REGEX INTERCEPTION TO TRUE REACT TOOL-CALLING AGENT

Dokumen ini mencatat keputusan arsitektural resmi untuk menghapus seluruh pola regex parsing / keyword interception dan menggantinya dengan siklus murni **ReAct Tool-Calling Agent (Reasoning + Acting)** pada sistem OpenDots.

---

## 1. Latar Belakang & Evaluasi Masalah (The Regex Anti-Pattern)

### Masalah pada Pendekatan Sebelumnya:
Sebelumnya, sistem di `src/server/omp-adapter.ts` menggunakan pencegatan kata kunci regex sebelum instruksi dikirim ke model AI:
- `lowerPrompt.includes('buka')`
- `lowerPrompt.includes('aplikasi apa')`
- `promptText.match(/kirim pesan ke/i)`
- `promptText.match(/klik/i)`

### Dampak Buruk dari Pendekatan Tersebut:
1. **Ilusi Kepintaran Palsu**: Sistem bukan bertindak sebagai AI agent otonom, melainkan hanya sekumpulan aturan `if-else` kaku.
2. **Kerapuhan Bahasa (Brittle Natural Language Handling)**:
   - Ketika pengguna mengetik `"coba buka #dowhatexcites di whatsapp"`, regex mengiranya membuka aplikasi macOS, bukan mengeklik obrolan WhatsApp.
   - Ketika pengguna mengetik `"tolong tengok obrolan itu"`, regex tidak cocok dan sistem macet.
   - Variasi bahasa alami yang sedikit berbeda langsung menggagalkan alur kerja.
3. **Template Statis yang Menyesatkan**:
   Pesan error terbungkus di bawah judul template statis seperti `"Aksi Balas Pesan Selesai!"` meskipun aksi sebenarnya gagal mendeteksi jendela.

---

## 2. Prinsip Arsitektur Baru: True Autonomous ReAct Agent

Mulai dari arsitektur ini, **SELURUH REGEX PARSING DIHAPUS**. Model bahasa besar (LLM: `gemini-flash-3.8 medium` atau `gpt-4o`) diberikan wewenang penuh untuk menalar bahasa alami pengguna dan memanggil alat (*Tool Use / Function Calling*) secara berurutan.

### Siklus Otonom ReAct (Reasoning + Acting Loop):
```
User Prompt (Bebas Bahasa Alami)
       │
       ▼
[LLM Reasoning / Thought]
"Apa tujuan user? Alat apa yang saya butuhkan untuk mencapainya?"
       │
       ▼
[Panggil Tool 1: Mata (Perception)]
`observe_workspace({ query: target })`
       │
       ▼
[Observation Result]
Menerima koordinat elemen (center_x, center_y) dari Apple Vision OCR
       │
       ▼
[LLM Reasoning / Thought Lanjutan]
"Elemen ditemukan di (x, y). Sekarang saya harus mengekliknya."
       │
       ▼
[Panggil Tool 2: Tangan (Action)]
`click_workspace({ x, y })`
       │
       ▼
[Observation & Settle]
Kursor visual bergerak, klik dieksekusi, frame kanvas diperbarui
       │
       ▼
[Final Response ke User]
Laporan kontekstual yang jujur dan akurat
```

---

## 3. Definisi Katalog Tool Resmi (Standard Tool Declarations)

Model AI dibekali 4 tool utama dengan skema JSON standar:

### Tool 1: `observe_workspace`
- **Fungsi**: Mengambil tangkapan layar jendela aktif di workspace kanan, menjalankan Apple Vision OCR (atau fallback `gpt-6-luna`), dan mengembalikan seluruh elemen teks/tombol beserta koordinat logisnya.
- **Parameter**:
  - `query` (string, opsional): Kata kunci teks spesifik yang dicari.
  - `provider` (string, enum: `["apple_vision", "vlm_luna", "hybrid"]`): Default `hybrid`.

### Tool 2: `click_workspace`
- **Fungsi**: Mengeklik koordinat logis `(x, y)` di dalam jendela aplikasi aktif pada workspace kanan tanpa membajak kursor fisik macOS host.
- **Parameter**:
  - `x` (number, wajib): Koordinat horizontal (origin kiri-atas).
  - `y` (number, wajib): Koordinat vertikal (origin kiri-atas).

### Tool 3: `type_in_workspace`
- **Fungsi**: Mengetikkan teks ke dalam kotak input yang sedang fokus di aplikasi aktif.
- **Parameter**:
  - `text` (string, wajib): Kalimat atau pesan yang akan diketikkan.

### Tool 4: `press_key_in_workspace`
- **Fungsi**: Menekan tombol khusus pada keyboard di aplikasi aktif.
- **Parameter**:
  - `key` (string, wajib): Contoh: `"Return"`, `"Tab"`, `"Escape"`.

---

## 4. Studi Kasus Alur Otonom (Autonomous Execution Flow)

### Skenario 1: Membuka Obrolan di WhatsApp
- **Prompt Pengguna**: *"coba buka #dowhatexcites di whatsapp"*
- **Penalaran Otonom Model**:
  1. *Thought*: Pengguna ingin membuka chat `#dowhatexcites`. Saya harus mencari posisi obrolan tersebut di layar WhatsApp.
  2. *Action*: `observe_workspace({ query: "#dowhatexcites" })`
  3. *Observation*: Ditemukan elemen `#dowhatexcites` pada koordinat `(276.91, 178.12)`.
  4. *Thought*: Obrolan berada di koordinat `(276.91, 178.12)`. Sekarang saya klik untuk membukanya.
  5. *Action*: `click_workspace({ x: 276.91, y: 178.12 })`
  6. *Output*: *"Saya telah menemukan obrolan #dowhatexcites dan mengekliknya untuk Anda."*

### Skenario 2: Mengirim Pesan WhatsApp (Alur 3-Tahap Otonom)
- **Prompt Pengguna**: *"tolong kirim pesan ke iweng 'halo rapat jam 2 ya'"*
- **Penalaran Otonom Model**:
  1. *Action 1*: `observe_workspace({ query: "iweng" })` -> Menerima koordinat kontak.
  2. *Action 2*: `click_workspace({ x: contactX, y: contactY })` -> Obrolan terbuka.
  3. *Action 3*: `observe_workspace({ query: "pesan" })` -> Menerima koordinat kolom teks bawah.
  4. *Action 4*: `click_workspace({ x: composerX, y: composerY })` -> Kotak input fokus berkedip.
  5. *Action 5*: `type_in_workspace({ text: "halo rapat jam 2 ya" })`
  6. *Action 6*: `press_key_in_workspace({ key: "Return" })`
  7. *Output*: *"Pesan 'halo rapat jam 2 ya' berhasil dikirim ke Iweng di WhatsApp."*

---

## 5. Kebijakan Scoped Active Workspace (Boundary Enforcement)

1. **Workspace Kanan Adalah Batas Kerja Agen**:
   Aplikasi yang sedang aktif di panel kanvas kanan (`activeWorkspaceSurface`, misal WhatsApp) adalah satu-satunya lingkungan kerja agen.
2. **Penolakan Permintaan di Luar Batas**:
   Jika pengguna meminta membuka atau mengontrol aplikasi di luar workspace kanan (misal meminta buka Safari saat WhatsApp aktif), model menolak dengan menjelaskan bahwa wewenangnya dibatasi demi keamanan sesi kerja.

---

## 6. Daftar Tugas Refactoring (Roadmap)

- [ ] Hapus seluruh logika pemecahan regex dan keyword parsing (`sendMatch`, `launchMatch`, `clickMatch`, dll.) di `src/server/omp-adapter.ts`.
- [ ] Daftarkan skema resmi Function Calling (Tool Definitions) ke dalam request payload model OMP / OpenAI-compatible endpoint.
- [ ] Implementasikan dispatcher eksekusi tool di server: ketika model menghasilkan `tool_calls`, panggil fungsi backend yang bersesuaian (`perceptionObserveWorkspace`, `cuaClick`, `cuaTypeText`, `cuaPressKey`), lalu kembalikan hasil observasi ke model untuk menghasilkan kesimpulan akhir.
- [ ] Lakukan verifikasi pengujian end-to-end tanpa bergantung pada kata kunci statis.
