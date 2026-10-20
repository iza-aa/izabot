# SYSTEM ARCHITECTURE SPECIFICATION: izabot (OMP + Modular Perception + CUA MCP Space)

> **INSTRUKSI MUTLAK UNTUK AI CODING AGENT:**
> Dokumen ini adalah _Single Source of Truth_ untuk arsitektur **izabot**.
>
> 1. **JANGAN** membuat ulang (_reinvent_) engine isolasi jendela (`CGVirtualDisplay`) atau engine injeksi klik (`AXUIElementPerformAction` / `CGEventPost`) secara manual. Semua itu **SUDAH** ditangani oleh **CUA MCP Space**.
> 2. **DILARANG KERAS** melakukan _hardcoding_ `PID`, `WindowID`, nama aplikasi (seperti "WhatsApp"), teks pencarian, atau koordinat piksel statis di bagian mana pun dalam kode (**Zero Hardcoding Policy**).
> 3. Tugasmu hanya membangun **Jembatan Integrasi (Orchestration & Perception Pipeline)** antara **OMP (Oh My Pi)**, **Modular Perception Layer (Apple Vision / ChatGPT Luna)**, **CUA MCP Space**, dan **Tauri Workspace Canvas**.

---

## 1. Gambaran Umum Topologi Sistem (High-Level Topology)

Sistem terdiri dari 4 komponen modular yang berkomunikasi melalui **Model Context Protocol (MCP)** dan **Local IPC/HTTP**:

```
+------------------------------------------------------------------------------+
|                              1. OMP (Oh My Pi)                               |
|  Peran: Agent Orchestrator & Chat Loop Utama                                 |
|  - Menerima instruksi natural language dari user                             |
|  - Mengatur state loop: [Observe via Mata] -> [Decide] -> [Act via CUA MCP]  |
+----------------------------------------------+-------------------------------+
| Panggil MCP Tool:                            | Panggil MCP Tool:
| perception_observe_workspace                 | cua_space_action
v                                              v
+-------------------------------------------+  +-------------------------------+
|     2. MATA (Modular Perception MCP)      |  |   3. ACTION: CUA MCP Space    |
|  Peran: Grounding & Ekstraksi Koordinat   |  |   (https://cua.ai/docs/spaces)|
|  - Mengambil frame terbaru dari CUA Space |  |  - Mengisolasi aplikasi aktif |
|  - Provider A: Apple Vision OCR (Lokal)   |  |    di dalam Space tersendiri  |
|  - Provider B: ChatGPT / Luna (VLM)       |  |  - Menjalankan klik, ketik,   |
|  - Output: Elemen UI & Koordinat Ternormal|  |    scroll tanpa membajak      |
|    yang sudah dipetakan ke skala CUA Space|  |    kursor mouse fisik macOS   |
+---------------------+---------------------+  +---------------+---------------+
                      |                                        |
+---------------------+----------------------------------------+
| Stream Frame & Koordinat Kursor
v
+------------------------------------------------------------------------------+
|                     4. TAURI 2 WORKSPACE CANVAS (Frontend)                   |
|  - Sisi Kiri : UI Chat terhubung ke OMP                                      |
|  - Sisi Kanan: Live Canvas merender aplikasi yang aktif di CUA Space         |
|  - Overlay   : Kursor SVG Virtual yang bergerak mengikuti koordinat aksi CUA |
+------------------------------------------------------------------------------+
```

---

## 2. Spesifikasi 4 Komponen Inti

### Komponen 1: Orchestrator - OMP (Oh My Pi)

- **Tanggung Jawab**: Menjadi otak percakapan dan pengambil keputusan langkah demi langkah (_ReAct / Tool-Use Loop_).
- **Aturan**: OMP tidak boleh menebak koordinat sendiri tanpa memanggil modul **Mata**. Setiap kali OMP ingin mengklik atau mengetik pada aplikasi di Workspace, OMP wajib:
  1. Memanggil tool persepsi (`perception_observe_workspace`) untuk membaca keadaan layar terbaru dari aplikasi apa pun yang sedang terhubung di CUA Space.
  2. Menganalisis daftar elemen/koordinat yang dikembalikan oleh Mata.
  3. Memanggil tool aksi milik **CUA MCP Space** (`click`, `type`, `scroll`, `key`) dengan koordinat hasil dari Mata.
  4. Melakukan verifikasi (observasi ulang) jika diperlukan, lalu mengembalikan laporan ke pengguna di UI Chat.

---

### Komponen 2: Mata - Modular Perception Layer (Pluggable Eye Engine)

Modul ini adalah jembatan yang memberikan "penglihatan" kepada OMP atas jendela aplikasi yang sedang berada di dalam CUA Space. Modul ini memiliki **Dual-Provider Architecture** yang bisa dipilih secara dinamis:

#### Provider A: `apple_vision` (Fast Local OCR Engine)

- **Teknologi**: Swift CLI memanggil `VNRecognizeTextRequest` (Apple Vision Framework) yang berjalan di Neural Engine M4 Pro (~10ms).
- **Kapan Digunakan**: Saat mencari teks eksplisit di layar (nama kontak, label tombol, isi chat, menu teks).
- **Cara Kerja**:
  1. Menerima buffer gambar dari jendela aktif di CUA Space beserta dimensi logisnya (`logical_width`, `logical_height`).
  2. Menjalankan `VNRecognizeTextRequest` (`recognitionLevel = .accurate`).
  3. Mengonversi _normalized bounding box_ milik Vision (yang titik `(0,0)`-nya berada di **kiri-bawah**) menjadi koordinat layar CUA Space (yang titik `(0,0)`-nya berada di **kiri-atas**):
     $$\text{TargetX} = \left( \text{bbox.origin.x} + \frac{\text{bbox.width}}{2} \right) \times \text{WindowLogicalWidth}$$
     $$\text{TargetY} = \left( 1.0 - \text{bbox.origin.y} - \frac{\text{bbox.height}}{2} \right) \times \text{WindowLogicalHeight}$$

#### Provider B: `vlm_luna` (ChatGPT / Luna Vision Grounding)

- **Teknologi**: Vision-Language Model API / Endpoint (ChatGPT Vision / Luna).
- **Kapan Digunakan**: Saat elemen target berupa ikon visual tanpa teks (ikon lampiran, tombol kirim berbentuk panah, avatar, tata letak kompleks) atau saat membutuhkan pemahaman visual menyeluruh.
- **Cara Kerja**:
  1. Mengirimkan tangkapan layar terbaru dari CUA Space ke endpoint ChatGPT / Luna bersama kueri elemen yang dicari.
  2. Menerima respons JSON terstruktur berisi koordinat `[x, y]` yang sudah dinormalisasi ke ukuran logis jendela CUA Space.

---

### Komponen 3: Action & Isolation - CUA MCP Space

- **Teknologi**: CUA Spaces Daemon (`cua.ai/docs/spaces`, berjalan di lokal misal port `3211`) yang diekspos sebagai MCP Server ke OMP.
- **Tanggung Jawab**:
  1. **Dynamic App Binding**: Mengisolasi jendela aplikasi apa pun (`target_app` / `window_id` yang dipilih user dari UI Tauri) ke dalam CUA Space tanpa _hardcoding_.
  2. **Zero Mouse Hijacking**: Mengeksekusi seluruh perintah `click(x, y)`, `move(x, y)`, `type(text)`, dan `hotkey(keys)` di dalam Space terisolasi tanpa menggerakkan kursor fisik pengguna di layar utama macOS.
  3. **Frame & State Provider**: Menyediakan tangkapan layar terbaru dari ruang kerja tersebut untuk dikonsumsi oleh modul **Mata** dan **Tauri Workspace Canvas**.

---

### Komponen 4: Frontend - Tauri 2 Connected Workspace Canvas

- **Teknologi**: Tauri 2 (Rust Core) + React + TypeScript + Vite.
- **Tanggung Jawab**:
  1. **App Selector**: Memungkinkan pengguna memilih aplikasi macOS mana pun yang sedang berjalan untuk dimasukkan ke dalam CUA Space.
  2. **Live Workspace Stream**: Merender visual aplikasi dari CUA Space secara _real-time_ di panel kanan.
  3. **Virtual Cursor Synchronization**: Menggambar kursor virtual (`<CursorOverlay />`) di atas elemen Canvas setiap kali OMP memicu aksi melalui CUA MCP Space, menggunakan rumus pemetaan skala responsif:
     ```typescript
     const canvasCursorX =
       (cuaActionX / windowLogicalWidth) * canvasElement.clientWidth;
     const canvasCursorY =
       (cuaActionY / windowLogicalHeight) * canvasElement.clientHeight;
     ```

---

## 3. Kontrak Data & Skema MCP Tool (Data Contracts)

### A. Tool Persepsi (`perception_observe_workspace`)

Dipanggil oleh OMP ketika ingin "melihat" isi aplikasi di dalam CUA Space.

**Input Schema:**

```json
{
  "name": "perception_observe_workspace",
  "description": "Membaca tampilan aplikasi yang sedang aktif di CUA Workspace menggunakan Apple Vision OCR atau ChatGPT/Luna Vision untuk mendapatkan daftar elemen dan koordinat klik yang valid.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "provider": {
        "type": "string",
        "enum": ["apple_vision", "vlm_luna", "hybrid"],
        "description": "Gunakan 'apple_vision' untuk pencarian teks cepat lokal, 'vlm_luna' untuk pemahaman visual/ikon, atau 'hybrid' untuk gabungan keduanya."
      },
      "query": {
        "type": "string",
        "description": "Opsional: Instruksi spesifik tentang elemen apa yang sedang dicari."
      },
      "settle_delay_ms": {
        "type": "number",
        "default": 300,
        "description": "Jeda waktu tunggu (ms) sebelum mengambil screenshot untuk memastikan animasi UI selesai."
      }
    },
    "required": ["provider"]
  }
}
```

**Output Schema (Dikembalikan ke OMP):**

```json
{
  "workspace_info": {
    "active_app_name": "DynamicAppName",
    "window_id": 4821,
    "logical_width": 1024,
    "logical_height": 768,
    "scale_factor": 2.0
  },
  "elements": [
    {
      "id": "el_1",
      "type": "text",
      "label": "Ketik pesan",
      "center_x": 540,
      "center_y": 720,
      "bounds": { "x": 320, "y": 700, "w": 440, "h": 40 },
      "confidence": 0.99,
      "source": "apple_vision"
    }
  ]
}
```

### B. Integrasi Tool Action ke CUA MCP Space

OMP langsung meneruskan `center_x` dan `center_y` dari output di atas ke tool bawaan CUA MCP Space, sambil mengirimkan event ke UI Tauri agar kursor virtual di Canvas bergerak:

- `cua_mouse_move(x: center_x, y: center_y)` -> Emit event Tauri `cua://cursor-move` `{ x: center_x, y: center_y }`.
- `cua_left_click(x: center_x, y: center_y)` -> Emit event Tauri `cua://cursor-click` `{ x: center_x, y: center_y }`.
- `cua_type_text(text: "...")` -> Emit event Tauri `cua://status` `{ action: "typing" }`.

---

## 4. Keputusan Arsitektural Final & Standardisasi Koordinat

1. **Struktur Repositori Modular**:
   - `src/server/` -> Hono API, OMP adapter, Swarm orchestrator, JIT approval, workspace, voice, dan stream jendela.
   - `src/client/` -> React + TypeScript + Vite UI (sidebar, chat, Space Workplace, Memories, kanvas desktop).
   - `src-tauri/` -> Shell desktop Tauri 2 yang memuat UI Vite.
   - `packages/perception-eye/` -> Binary Swift CLI Apple Vision OCR & adapter VLM Luna.
   - `packages/mcp-bridge/` -> Node.js / TypeScript MCP Server (`@modelcontextprotocol/sdk`).
   - `bin/` -> Binary hasil build perception engine yang dipakai runtime lokal.
   - `tests/` -> Vitest untuk server, client helper, delegation, JIT, dan stream ticket.

2. **Enumerasi Jendela Dinamis**:
   - `perception-eye list-windows` menyediakan daftar jendela aktif (`window_id`, `owner_name`, `pid`, `logical_width`, `logical_height`, `window_title`) secara real-time via `CGWindowListCopyWindowInfo`.
   - Mengeliminasi kebutuhan hardcode aplikasi.

3. **Standardisasi Logical Points**:
   - Seluruh koordinat (`center_x`, `center_y`, `bounds`) wajib dalam unit **Logical Points** (`kCGWindowBounds`), bukan physical image pixels.

4. **Anti-Stale Frame Mechanism**:
   - Default `settle_delay_ms = 300` diterapkan pada `perception_observe_workspace` untuk menjamin animasi pergantian layar telah stabil sebelum OCR dipanggil.

---

## 5. Implementasi Runtime Saat Ini

- **Chat & agent**: `src/server/app.ts` menerima chat, lalu `src/server/omp-adapter.ts` menjalankan loop ReAct OMP dengan tool desktop, halaman, memori, `delegate_to_dot`, dan JIT.
- **Workspace**: SQLite menyimpan Space, Dot, binding thread, page, app binding, dan preferensi. App playbook disimpan terpisah di `data/app-memory/`.
- **Frontend shell**: `src/client/App.tsx` mengatur satu hierarki `SPACES ▸ Dots`, view chat, Workplace, Activity, dan Memories. Dialog Space/Dot/karakter/memori/schedule berada di `WorkspaceDialog.tsx`.
- **Desktop**: window list, capture, input, dan cursor memakai layer desktop lokal; stream biner dikirim melalui WebSocket. Semua fetch langsung ke `/api` wajib membawa owner token yang sama dengan helper `api()`.
- **Wordmark**: UI saat ini masih memakai `OpenDots`. Rebrand ke `izabot` belum dijalankan sampai ada konfirmasi eksplisit.

## 6. Delegasi Multi-Agent (`delegate_to_dot`)

- Tool `delegate_to_dot` hanya tersedia pada depth 0. `MAX_DELEGATION_DEPTH = 1`; worker depth 1 tidak mendapatkan tool delegasi di prompt maupun executor.
- Worker menerima satu objective dan tidak boleh menerima desktop surface jika objective murni teks. Heuristik `delegatedTaskNeedsSurface` memilih surface hanya untuk objective yang menyebut app/window/desktop atau aksi visual.
- Batas waktu worker: `DELEGATE_TIMEOUT_MS = 55_000`, `SUB_AGENT_STEP_TIMEOUT_MS = 45_000`, maksimum 4 langkah, dan satu percobaan delegasi per turn parent.
- Kegagalan non-retryable mengembalikan `retryable: false`; parent berhenti dan menampilkan pesan gagal daripada mengulang loop.
- Orchestrator `agent-swarm-orchestrator.ts` membuat tiket, mengirim progress ke `progressEvents`, membersihkan listener di `finally`, dan menulis `Delegation Trace` di jawaban akhir.
- Worker memakai surface yang sama hanya jika diizinkan; hasil akhirnya dikembalikan ke parent sebagai `[COMPLETED] <Dot>: <hasil>`.

## 7. JIT Scripting dengan Owner Approval

- `dynamic-script-runner.ts` memvalidasi script; `jit-approvals.ts` menyimpan approval in-memory yang terikat pada owner, thread, Dot, dan Space.
- Alur: Dot memanggil tool JIT -> server membuat approval request -> turn berhenti dengan `status: approval_required` -> owner menjalankan `/jit-list`, `/jit-review <id>`, lalu `/jit-approve <id>` atau `/jit-deny <id>`.
- Approval bersifat satu kali, kedaluwarsa setelah 1 jam, dan maksimum 3 request pending per percakapan. Approval hanya berlaku di thread/Dot/Space yang sama.
- Eksekusi dibatasi 20.000 karakter kode, 4.000 karakter argumen, timeout 15 detik, tanpa secret, tanpa self-healing otomatis, dan tanpa promosi tool dari chat.
- JIT aktif secara default; `IZABOT_ENABLE_JIT=0` menyembunyikan tool. Script berjalan sebagai user macOS dan **tidak** di-OS-sandbox; review kode persis adalah batas keamanannya.
- Approval hilang saat server restart karena disimpan di memori.

## 8. Keamanan Stream Jendela

- Capture awal memakai `fetch` dengan header owner, bukan `<img src>` tanpa autentikasi.
- WebSocket `/api/connected-apps/stream/:windowId` memerlukan tiket sekali pakai berumur 30 detik yang diterbitkan oleh endpoint API yang dilindungi owner.
- Tiket terikat pada `windowId`, dihapus setelah dipakai, dan ditolak jika tidak ada, salah window, atau kedaluwarsa.
