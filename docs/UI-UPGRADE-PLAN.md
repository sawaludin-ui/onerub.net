# onerub.net — Rencana Upgrade UI/UX (5/10 → 10/10)

Tanggal: 2026-11-22 WIB · Scope: **presentasi saja** (visual + motion + type + warna).
Status: **RENCANA untuk di-ACC dulu. Belum ada yang diubah/di-deploy.**

Prinsip: konten & copy sudah bagus + jujur — **tidak dirombak**. Fungsi, kontrak, API, wallet flow **tidak disentuh**. Ini murni lapisan tampilan: `app/globals.css`, pemuatan font di `app/layout.js`, sedikit className/markup di komponen, + 1 modul JS motion kecil.

---

## 1. Audit jujur — kenapa sekarang terasa 5/10

| # | Masalah | Dampak |
|---|---|---|
| 1 | **Body pakai Arial** (tanpa web font), display Barlow Condensed (umum/templatey) | Tell "murah" paling besar; tipografi tidak premium |
| 2 | Palet nyaris mono: canvas abu kusam `#e5e5e5`, mint dipakai tipis, kuning hampir tak terpakai | Flat, tanpa kedalaman/cahaya, tidak ada "brand story" (BNB gold tak dimanfaatkan) |
| 3 | **Nol motion** selain headline hero | Statis, tidak ada "wow"; situs 10/10 punya reveal, hover, count-up |
| 4 | **Bug mobile**: headline hero ke-clip (huruf kepotong), CTA utama tampil abu seperti disabled | Kelihatan rusak/belum jadi di HP |
| 5 | Kartu & chip flat, status "unknown/unknown", blok readiness tan `#f3e7c1` tabrakan | Terkesan placeholder/belum selesai |
| 6 | Tanpa elevation/shadow, tanpa gradient halus, fokus ring warna campur (`#17632c`, `#3562a5`) | Kurang polish & konsistensi |
| 7 | CSS sudah banyak layer override + `!important` (mis. `.hero-upgrade`) | Rapuh, susah dirawat |

---

## 2. Yang akan DIUBAH

### 2a. Sistem tipografi (self-host woff2, subset, `font-display:swap`, preload)
- **Body**: Arial → **Inter** (variable) — premium, tajam di ukuran kecil, naikkan hierarki.
- **Display**: Barlow Condensed → **Clash Display** (atau alt **Archivo Expanded**) — grotesk tegas & khas untuk headline besar.
- **Mono** (label/data/tx): system mono → **Geist Mono** (atau **JetBrains Mono**) — pas untuk produk crypto/agent.
- Skala tipe baru (ukuran, tracking, leading) + perbaiki secondary text yang terlalu abu agar kontras lolos WCAG AA.
- Font self-host → aman dengan CSP ketat (tak perlu origin font eksternal).

### 2b. Warna + kedalaman (disiplin, maksimal 2 aksen tampil bersamaan)
- Canvas: `#e5e5e5` kusam → **paper hangat** `#f6f5f2`; section gelap jadi **ink pekat** `#0a0a0b` (bukan abu).
- Aksen **mint** `#d1ffca` dipertahankan sebagai signature "pay/success".
- Tambah **gold BNB** (mis. `#F0B90B`) khusus untuk nilai/bounty/angka — mengikat ke BNB Chain.
- Tambah token **elevation** (shadow lembut berlapis), **gradient/aurora sangat halus** di panel gelap, opsi **grain** tipis, fokus ring **satu warna** konsisten.
- Konsolidasi token di `:root`, buang `!important` hacks.

### 2c. Perbaikan komponen & bug
- **Fix clip headline mobile** (atur overflow/padding/line-box animasi) + **CTA utama** tak lagi tampak disabled saat normal.
- Kartu: hover **lift + shadow + garis aksen**, radius & border dirapikan.
- Chip status: **dot berwarna + label**, state "unknown" dibikin kalem (bukan seperti error).
- Empty state & blok readiness: selaras palet (ganti tan yang tabrakan).
- Tombol: depth + press state + shine opsional + state loading konsisten.
- Nav: **shrink + backdrop blur** saat scroll.

---

## 3. Yang akan DITAMBAH (motion layer — semua hormati `prefers-reduced-motion`)
- **Scroll reveal** bertahap per section (fade + rise, stagger) via IntersectionObserver.
- **Count-up** angka stat (0 → 90% / 10% / funded tasks) saat masuk viewport.
- **Hover kartu** magnetik/elevate; simbol task sudah rotate (dipertahankan).
- **Parallax halus** sculpture hero mengikuti mouse/scroll.
- **Gradient/aurora bergerak** sangat halus di panel gelap ("BOUNDARIES"/"TRUST").
- Micro-interaction tombol & link (sudah ada underline slide — diperkaya).

---

## 4. Yang TIDAK disentuh
- Copy/konten/pesan (sudah jujur & sesuai brief) — tidak ditulis ulang.
- Fungsi apa pun: wallet, API routes, kontrak, escrow, task flow.
- Struktur data/SSR, CSP keamanan (font self-host agar tetap ketat).
- Playground/Office lama.

---

## 5. Risiko & cara rollout (biar aman + kamu lihat dulu)
- Risiko rendah: hanya layer tampilan; tidak ada perubahan logika.
- Rollout: **(1)** saya bikin **preview visual** (mock statis, TIDAK di-deploy) biar kamu lihat arah font/warna/motion → **(2)** kamu ACC/revisi arah → **(3)** saya terapkan ke situs asli + uji di browser (desktop+mobile, reduced-motion, Lighthouse) → **(4)** baru deploy Vercel setelah kamu oke.

---

## 6. Keputusan yang saya minta (boleh "ikut kamu")
1. Arah font: **Clash Display + Inter + Geist Mono** (rekomendasi saya) — oke atau mau lain?
2. Aksen: pertahankan **mint** + tambah **gold BNB** — atau mint saja?
3. Mau saya bikin **preview visual dulu** sebelum sentuh situs asli (rekomendasi), atau langsung terapkan lalu kamu review di staging?
