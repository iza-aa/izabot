# SYSTEM ARCHITECTURE SPECIFICATION: izabot (OMP + Modular Perception + CUA MCP Space)

> **INSTRUKSI MUTLAK UNTUK AI CODING AGENT:**
> Dokumen ini adalah *Single Source of Truth* untuk arsitektur **izabot**. 
> 1. **JANGAN** membuat ulang (*reinvent*) engine isolasi jendela (`CGVirtualDisplay`) atau engine injeksi klik (`AXUIElementPerformAction` / `CGEventPost`) secara manual. Semua itu **SUDAH** ditangani oleh **CUA MCP Space**.
> 2. **DILARANG KERAS** melakukan *hardcoding* `PID`, `WindowID`, nama aplikasi (seperti "WhatsApp"), teks pencarian, atau koordinat piksel statis di bagian mana pun dalam kode (**Zero Hardcoding Policy**).
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
* **Tanggung Jawab**: Menjadi otak percakapan dan pengambil keputusan langkah demi langkah (*ReAct / Tool-Use Loop*).
* **Aturan**: OMP tidak boleh menebak koordinat sendiri tanpa memanggil modul **Mata**. Setiap kali OMP ingin mengklik atau mengetik pada aplikasi di Workspace, OMP wajib:
  1. Memanggil tool persepsi (`perception_observe_workspace`) untuk membaca keadaan layar terbaru dari aplikasi apa pun yang sedang terhubung di CUA Space.
  2. Menganalisis daftar elemen/koordinat yang dikembalikan oleh Mata.
  3. Memanggil tool aksi milik **CUA MCP Space** (`click`, `type`, `scroll`, `key`) dengan koordinat hasil dari Mata.
  4. Melakukan verifikasi (observasi ulang) jika diperlukan, lalu mengembalikan laporan ke pengguna di UI Chat.

---

### Komponen 2: Mata - Modular Perception Layer (Pluggable Eye Engine)
Modul ini adalah jembatan yang memberikan "penglihatan" kepada OMP atas jendela aplikasi yang sedang berada di dalam CUA Space. Modul ini memiliki **Dual-Provider Architecture** yang bisa dipilih secara dinamis:

#### Provider A: `apple_vision` (Fast Local OCR Engine)
* **Teknologi**: Swift CLI memanggil `VNRecognizeTextRequest` (Apple Vision Framework) yang berjalan di Neural Engine M4 Pro (~10ms).
* **Kapan Digunakan**: Saat mencari teks eksplisit di layar (nama kontak, label tombol, isi chat, menu teks).
* **Cara Kerja**:
  1. Menerima buffer gambar dari jendela aktif di CUA Space beserta dimensi logisnya (`logical_width`, `logical_height`).
  2. Menjalankan `VNRecognizeTextRequest` (`recognitionLevel = .accurate`).
  3. Mengonversi *normalized bounding box* milik Vision (yang titik `(0,0)`-nya berada di **kiri-bawah**) menjadi koordinat layar CUA Space (yang titik `(0,0)`-nya berada di **kiri-atas**):
     $$\text{TargetX} = \left( \text{bbox.origin.x} + \frac{\text{bbox.width}}{2} \right) \times \text{WindowLogicalWidth}$$
     $$\text{TargetY} = \left( 1.0 - \text{bbox.origin.y} - \frac{\text{bbox.height}}{2} \right) \times \text{WindowLogicalHeight}$$

#### Provider B: `vlm_luna` (ChatGPT / Luna Vision Grounding)
* **Teknologi**: Vision-Language Model API / Endpoint (ChatGPT Vision / Luna).
* **Kapan Digunakan**: Saat elemen target berupa ikon visual tanpa teks (ikon lampiran, tombol kirim berbentuk panah, avatar, tata letak kompleks) atau saat membutuhkan pemahaman visual menyeluruh.
* **Cara Kerja**:
  1. Mengirimkan tangkapan layar terbaru dari CUA Space ke endpoint ChatGPT / Luna bersama kueri elemen yang dicari.
  2. Menerima respons JSON terstruktur berisi koordinat `[x, y]` yang sudah dinormalisasi ke ukuran logis jendela CUA Space.

---

### Komponen 3: Action & Isolation - CUA MCP Space
* **Teknologi**: CUA Spaces Daemon (`cua.ai/docs/spaces`, berjalan di lokal misal port `3211`) yang diekspos sebagai MCP Server ke OMP.
* **Tanggung Jawab**:
  1. **Dynamic App Binding**: Mengisolasi jendela aplikasi apa pun (`target_app` / `window_id` yang dipilih user dari UI Tauri) ke dalam CUA Space tanpa *hardcoding*.
  2. **Zero Mouse Hijacking**: Mengeksekusi seluruh perintah `click(x, y)`, `move(x, y)`, `type(text)`, dan `hotkey(keys)` di dalam Space terisolasi tanpa menggerakkan kursor fisik pengguna di layar utama macOS.
  3. **Frame & State Provider**: Menyediakan tangkapan layar terbaru dari ruang kerja tersebut untuk dikonsumsi oleh modul **Mata** dan **Tauri Workspace Canvas**.

---

### Komponen 4: Frontend - Tauri 2 Connected Workspace Canvas
* **Teknologi**: Tauri 2 (Rust Core) + React + TypeScript + Vite.
* **Tanggung Jawab**:
  1. **App Selector**: Memungkinkan pengguna memilih aplikasi macOS mana pun yang sedang berjalan untuk dimasukkan ke dalam CUA Space.
  2. **Live Workspace Stream**: Merender visual aplikasi dari CUA Space secara *real-time* di panel kanan.
  3. **Virtual Cursor Synchronization**: Menggambar kursor virtual (`<CursorOverlay />`) di atas elemen Canvas setiap kali OMP memicu aksi melalui CUA MCP Space, menggunakan rumus pemetaan skala responsif:
     ```typescript
     const canvasCursorX = (cuaActionX / windowLogicalWidth) * canvasElement.clientWidth;
     const canvasCursorY = (cuaActionY / windowLogicalHeight) * canvasElement.clientHeight;
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
   - `packages/perception-eye/` -> Binary Swift CLI Apple Vision OCR & adapter VLM Luna.
   - `packages/mcp-bridge/` -> Node.js / TypeScript MCP Server (`@modelcontextprotocol/sdk`).
   - `apps/desktop/` -> Frontend Tauri 2 + React + TypeScript + Vite.
   - `_archive_swift/` -> Arsip codebase legacy Swift.

2. **Enumerasi Jendela Dinamis**:
   - `perception-eye list-windows` menyediakan daftar jendela aktif (`window_id`, `owner_name`, `pid`, `logical_width`, `logical_height`, `window_title`) secara real-time via `CGWindowListCopyWindowInfo`.
   - Mengeliminasi kebutuhan hardcode aplikasi.

3. **Standardisasi Logical Points**:
   - Seluruh koordinat (`center_x`, `center_y`, `bounds`) wajib dalam unit **Logical Points** (`kCGWindowBounds`), bukan physical image pixels.

4. **Anti-Stale Frame Mechanism**:
   - Default `settle_delay_ms = 300` diterapkan pada `perception_observe_workspace` untuk menjamin animasi pergantian layar telah stabil sebelum OCR dipanggil.
