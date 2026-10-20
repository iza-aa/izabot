# DESIGN.md — OpenDots & izabot Design System Specification

Dokumen spesifikasi desain antarmuka (_UI/UX Design System_) resmi untuk pengembangan aplikasi desktop **`OpenDots`** (`izabot`). Dokumen ini menjadi pedoman mutlak agar seluruh penambahan atau modifikasi UI di masa mendatang **tetap 100% konsisten, elegan, dan tidak membuat styling sembarangan**.

---

## 1. Filosofi & Karakter Visual

Desain OpenDots mengusung estetika **"Warm Precision Desktop Workspace"**:

- **Bukan Chatbot Generik**: Menggabungkan kehangatan asisten personal (maskot 3D, warna lavender lembut) dengan presisi alat kerja profesional (garis tipis, font sistem Mac yang tajam, layout split-screen).
- **Subtle & Restrained**: Menggunakan garis pemisah tipis (`1px solid var(--line)`), bayangan sangat halus, tanpa gradien neon berlebih, dan tanpa elemen visual yang berteriak.
- **Dua Tema Harmonis (Light & Dark Mode)**:
  - _Light Mode_: Latar belakang bernuansa kertas lembut (`#f8f7f4`), sidebar `#fbfaf8`, aksen biru lavender (`#7285d5`).
  - _Dark Mode_: Latar belakang abu-abu gelap pekat netral (`#1b1b1b`), kartu `#242426`, garis `#2e2e30`, teks `#e4e3df`.

---

## 2. Token Desain Resmi (Design Tokens)

Seluruh komponen wajib menggunakan variabel CSS berikut:

### A. Palet Warna Light Theme (`:root`)

| Variabel       | Nilai Hex | Penggunaan                                               |
| -------------- | --------- | -------------------------------------------------------- |
| `--bg-app`     | `#f8f7f4` | Latar belakang canvas utama aplikasi.                    |
| `--bg-sidebar` | `#fbfaf8` | Latar belakang bilah samping navigasi (sidebar).         |
| `--bg-card`    | `#ffffff` | Latar belakang kartu, input, dan panel modal.            |
| `--ink`        | `#333641` | Warna teks primer (judul, isi pesan pengguna).           |
| `--muted`      | `#8c8d97` | Warna teks sekunder, label pembantu, timestamp.          |
| `--line`       | `#e9e8e6` | Garis batas (_border_) kartu, pemisah kolom, input.      |
| `--line-input` | `#dedee6` | Batas input dan textarea saat tidak aktif.               |
| `--blue`       | `#7285d5` | Aksen tombol primer, dot aktif, tautan.                  |
| `--blue-dark`  | `#5269bb` | Hover state tombol primer aksen.                         |
| `--lavender`   | `#eeeffa` | Latar belakang bubble chat bot, badge aksen, hover item. |
| `--focus-ring` | `#b8c4fa` | Ring fokus aksesibilitas (`outline: 3px solid #b8c4fa`). |

### B. Palet Warna Dark Theme (`:root[data-theme='dark']`)

| Variabel       | Nilai Hex / OKLab | Penggunaan                                   |
| -------------- | ----------------- | -------------------------------------------- |
| `--bg-app`     | `#1b1b1b`         | Latar belakang kanvas utama saat dark mode.  |
| `--bg-sidebar` | `#202022`         | Latar belakang sidebar saat dark mode.       |
| `--bg-card`    | `#242426`         | Latar belakang kartu dan modal dark mode.    |
| `--ink`        | `#e4e3df`         | Warna teks primer di dark mode.              |
| `--muted`      | `#8a8991`         | Teks sekunder dan ikon netral di dark mode.  |
| `--line`       | `#2e2e30`         | Garis batas kartu dan border di dark mode.   |
| `--blue`       | `#8496e0`         | Aksen biru terang untuk kontras gelap.       |
| `--lavender`   | `#2a2b38`         | Latar belakang bubble chat bot di dark mode. |

---

## 3. Tipografi & Skala Ukuran Font

- **Font Family**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- **Ukuran Dasar (_Base Size_)**: `14px`, `line-height: 1.65`.
- **Hierarki Heading**:
  - `Wordmark Logo`: `23px`, `font-weight: 700`, `letter-spacing: -1px`.
  - `Page / Hero Title (h1)`: `37px`, `font-weight: 500`, `letter-spacing: -1.4px`, `line-height: 1.17`.
  - `Section Title (h2)`: `15px–17px`, `font-weight: 550`, `letter-spacing: -0.2px`.
  - `Subheading / Label (h3)`: `13px–14px`, `font-weight: 500`.
  - `Body Text (p)`: `14px`, `font-weight: 400`, `line-height: 1.7`.
  - `Caption / Subtitle`: `11px–12px`, `color: var(--muted)`.
  - `Micro Label / Badge`: `9px–10px`, `font-weight: 600`, `text-transform: uppercase`.

---

## 4. Standar Geometri & Border Radius

Dilarang menggunakan border-radius acak. Gunakan standar geometri OpenDots:

- **Button & Input**: `border-radius: 9px`.
- **Cards, Panes & Modals**: `border-radius: 12px` (atau `16px` untuk modal besar).
- **Pills & Badges**: `border-radius: 9999px` (capsule).
- **Browser Window Frame di Computer Panel**: `border-radius: 8px 8px 0 0` (top) dan `0 0 8px 8px` (bottom).

---

## 5. Spesifikasi Komponen Inti

### A. Tombol (`button`)

- **Default / Secondary Button**:
  - `background: white` (dark: `#28282b`).
  - `border: 1px solid var(--line)`.
  - `border-radius: 9px`.
  - `padding: 9px 13px`.
  - `font-size: 13px`.
  - Hover: `background: #f4f4f9` (dark: `#323236`).
  - Active: `transform: translateY(1px)`.
- **Primary Action Button (Save / Submit / Approve)**:
  - `background: var(--blue)` (`#7285d5`).
  - `color: white`.
  - `border: 1px solid var(--blue-dark)`.
  - Hover: `background: var(--blue-dark)`.
- **Focus Ring Wajib**:
  - `:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 3px; }`.

### B. Form Input (`input`, `textarea`, `select`)

- `border: 1px solid var(--line-input)`.
- `border-radius: 9px`.
- `padding: 10px 12px`.
- `background: #fff` (dark: `#242426`).
- `color: var(--ink)`.
- Focus: `:focus { border-color: var(--blue); outline: 3px solid var(--focus-ring); outline-offset: 0; }`.

### C. Sidebar Kiri (Navigasi Utama)

- Lebar tetap: `width: 242px`, `flex-shrink: 0`.
- Latar belakang: `#fbfaf8` (dark: `#202022`).
- Batas kanan: `border-right: 1px solid var(--line)`.
- Hanya ada **satu hierarki Spasi**: `SPACES ▸ Dots`. Tidak boleh ada bagian `DOTS` terpisah atau daftar Dot duplikat.
- Komponen di dalam sidebar:
  1. `Wordmark`: Logo dotted 4 bulatan (`.dotted-logo`) + teks wordmark. Wordmark saat ini masih `"OpenDots"`; rebrand ke `izabot` menunggu konfirmasi.
  2. Tombol `+ New chat` penuh di bawah logo.
  3. Header `SPACES` dengan tombol `+` untuk membuat Space.
  4. Setiap Space memiliki tombol disclosure, nama, jumlah Dot, dan daftar Dot di bawahnya. Baris Dot membuka chat; tombol titik tiga membuka editor Dot.
  5. `New Dot` berada di dalam Space yang sedang dibuka, bukan di tingkat atas sidebar.
  6. Bagian `RECENT CHATS` menampilkan percakapan lokal, judul, dan nama Dot.
  7. Bagian bawah: `Scheduled & activity`, `Memories`, `Settings`.

### D. Karakter Dot (Character Picker)

- Editor Dot memakai bagian **Character** dengan lima pilihan: `Auto`, `Blue`, `Mint`, `Orange`, dan `Purple`.
- Setiap pilihan menampilkan maskot 3D yang sama dengan warna berbeda. `Auto` memakai warna deterministik dari identitas Dot.
- Pilihan karakter bersifat opsional; Dot lama tanpa nilai `avatar` tetap valid dan otomatis memakai `Auto`.
- Warna karakter tidak boleh mengubah warna aksen global, status, atau warna tombol primer.

### E. Space Workplace

- Membuka Space menampilkan halaman **Workplace** dengan urutan bagian: `Workers`, `Apps`, `Automations`, dan `Pages`.
- `Workers` menampilkan Dot yang tergabung di Space, dengan aksi `Chat` dan `Edit`.
- `Apps` menampilkan aplikasi macOS yang di-bind ke Space. Input nama aplikasi dan tombol `Bind app` baru aktif setelah ada teks; chip aplikasi memiliki aksi `Unbind`.
- `Automations` hanya menampilkan scheduled task yang berasal dari percakapan di Space tersebut.
- `Pages` mendukung pencarian, pengurutan `Recently edited` / `Name A–Z`, tampilan grid/list, dan tombol `New page`.

### F. Memories

- `Memories` adalah satu tampilan terpadu: preferensi eksplisit dari SQLite dan playbook aplikasi dari H-GAM.
- Preferensi memakai tombol `Add memory`; playbook aplikasi memakai kartu per aplikasi dengan aksi `Forget <app> playbook`.
- Memori tidak boleh otomatis dikirim ke provider model jika toggle `Use saved memories` dimatikan.

### G. Layout Terbagi Workspace (_Split-Screen Workspace_)

- Ketika panel komputer atau dokumen dibuka bersamaan dengan chat:
  - Menggunakan container `.chat-workspace.split`.
  - **Sisi Kiri (`.chat-column`)**: Menampilkan percakapan chat, stream respons AI, dan input bar prompt.
  - **Sisi Kanan (`.result-pane`)**: Lebar tetap `400px–500px` untuk menampilkan **`.computer-view`** (jendela aplikasi yang terhubung) atau dokumen aktif.

### H. Komponen Kanvas Komputer / Aplikasi (`.computer-view`)

- **Top Browser Bar (`.browser-bar`)**:
  - `padding: 8px 12px`.
  - Tiga titik jendela (merah, kuning, hijau) atau ikon aplikasi.
  - Label judul aplikasi target (misal: _WhatsApp Desktop_, _Safari_).
  - Status koneksi: titik hijau _Connected (Local M4 Pro)_.
- **Viewport Frame (`.computer-view > img / video / canvas`)**:
  - Menampilkan stream jendela aplikasi secara eksklusif (tanpa merekam layar fisik lain).
  - `border: 1px solid var(--line)`.
  - `border-radius: 0 0 8px 8px`.
  - Di atas viewport ini, kursor visual agen bergerak dan mengeklik elemen UI.

### I. Kartu Persetujuan Tindakan (_Human-in-the-Loop Action Card_)

- Digunakan saat agen hendak melakukan aksi penting (mengetik, mengirim pesan, atau menyimpan data):
  - Wadah kartu: `border: 1px solid var(--line)`, `border-radius: 12px`, `padding: 16px`, `background: var(--bg-card)`.
  - Judul: Ringkasan aksi yang akan diambil agen (misal: _"Kirim draf balasan ke Raka di WhatsApp"_).
  - Dua tombol aksi di kanan bawah kartu:
    - Tombol Sekunder: `[Batal / Reject]` (abu-abu netral).
    - Tombol Primer: `[Approve & Run]` (warna biru aksen `var(--blue)`).

---

## 6. Aturan Pantangan (Anti-Slop Invariants)

1. **Dilarang Menambahkan Warna Acak Inline**: Semua warna wajib mengambil dari variabel resmi (`var(--ink)`, `var(--muted)`, `var(--line)`, `var(--blue)`, `var(--lavender)`).
2. **Dilarang Membuat Tombol Bersudut Terlalu Tajam atau Bulat Penuh (Kecuali Capsule Badge)**: Tombol aksi wajib memiliki `border-radius: 9px`.
3. **Dilarang Menghilangkan Focus Ring**: Setiap elemen yang bisa diklik wajib mempertahankan `:focus-visible` dengan outline 3px untuk aksesibilitas keyboard macOS.
4. **Dilarang Merusak Layout Split-Screen**: Kanvas jendela aplikasi dan kolom chat wajib berdampingan secara proporsional di dalam `.chat-workspace.split`.
