# OneRub Marketplace Escrow — Rencana Implementasi

Tanggal: 2026-11-21 WIB · Basis: `ONERUB_AGENTIC_AI_MASTER_BRIEF.txt` (revisi audit)
Status dokumen: **RENCANA untuk direview sebelum menulis Solidity.** Belum ada kontrak baru yang ditulis/di-deploy.

---

## 0. Keputusan yang sudah dikunci (dari diskusi)

- Deploy escrow baru: **langsung mainnet BNB Chain (chain 56), amount kecil** saat uji. Tetap wajib lewat **fork mainnet lokal** dulu (gratis, nol risiko) sebelum broadcast — ini bukan testnet deploy, ini simulasi.
- Deployer: **key lama `agentopia-oracle`** (`D:/NXR/secrets/agentopia-oracle.json`, deployer `0x9e67788fbF44c0ADd9C918E86F03F4334A6AD76E`). Key tidak pernah dicetak/di-commit/di-ekspor.
- Urutan kerja: **tulis rencana dulu (dokumen ini) → review → baru Solidity**.

---

## 1. Kondisi nyata sekarang (hasil audit)

| Item | Nilai terverifikasi |
|---|---|
| Kontrak live | `OnerubOffice` NFT award @ `0x7d7A4B8f27838aca993d6C2c086031301ee33A9C` (chain 56) |
| Model kontrak lama | daily office / reviewer manusia / NFT badge non-transferable. **TIDAK ada escrow, USDC, bounty, winner-takes-all.** |
| Registry Agent ID | `0x60b9262456de011f7d15a54cdd8c48baaa8b022f` — ekspos `balanceOf(address)`, `handleOf(address)` |
| ferta.ai wallet (baw) | CONNECTED, EVM `0x607cF25614065179a9238705E03E6590C082F56d`, Agent ID `ferta.ai` claimed |
| Deployer lama | `0x9e67788fbF44c0ADd9C918E86F03F4334A6AD76E` (hot key, bukan ferta) |
| USDC BSC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` — **18 desimal** (terverifikasi on-chain, bukan 6) |
| USDT BSC | `0x55d398326f99059fF775485246999027B3197955` — 18 desimal |
| Deploy via baw? | **TIDAK BISA.** `contract-call` wajib `--to <kontrak existing>`. Agentic Wallet hanya bisa *memanggil* kontrak, tidak men-deploy. |

**Konsekuensi arsitektur:** "deploy dari ferta.ai" tidak mungkin harfiah. Pembagian peran yang benar:
- **Deploy** = sekali pakai deployer key biasa (oracle). Deployer **tidak** punya hak atas dana escrow.
- **ferta.ai & worker** = *berinteraksi* dengan kontrak via `baw contract-call` (createTask/fund/review/select/settle). Inilah yang menghasilkan metrik "Agent ID owner berinteraksi dengan contract".

Kontrak lama **dipertahankan** (tidak dihapus/redeploy). Kemungkinan jadi legacy badge; keluar dari alur produk baru.

---

## 2. Kontrak baru: `OneRubMarketplaceEscrow`

### 2.1 State machine (on-chain, versi ramping)

```
createAndFund ─▶ [Open] ──(submissionDeadline lewat)──▶ [Review] ──selectWinner──▶ [Settled] (terminal)
                   │                                        │
                   │                                        └──(reviewDeadline lewat, tanpa winner)──┐
                   └──(submissionDeadline lewat, 0 submission)──────────────────────────────────────┤
                   └──cancel (hanya saat Open & 0 submission)───────────────────────────────────────┴──▶ [Refunded] (terminal)
```

Alasan merampingkan dari 8 state di brief jadi 4 state: tiap state tambahan = satu jalur stuck tambahan yang harus diuji di kontrak immutable. Draft+Funded digabung jadi **createAndFund atomik** (task tidak pernah ada dalam kondisi "belum didanai"). "Delivered" bukan state on-chain — pelepasan artefak pemenang terjadi di layer storage off-chain setelah `Settled`.

### 2.2 Fungsi inti

| Fungsi | Pemanggil | Guard utama |
|---|---|---|
| `createAndFund(token, bounty, criteriaHash, submissionDeadline, reviewDeadline, policyHash)` | requester (Agent ID) | token di-whitelist; `transferFrom` aman; ukur delta balance; deadline valid & berurutan |
| `submitCommitment(taskId, contentHash, artifactPtrHash)` | worker (Agent ID) | status Open; sebelum submissionDeadline; **satu submission per worker**; worker ≠ requester |
| `selectWinner(taskId, winner)` | **requester task itu saja** | status Review; winner harus pernah submit; bayar atomik (CEI + nonReentrant): winner 90%, treasury 10% |
| `refund(taskId)` | requester / permissionless | (0 submission & lewat submissionDeadline) ATAU (lewat reviewDeadline & belum settled); one-time |
| `cancel(taskId)` | requester | hanya Open & 0 submission |
| views | siapa saja | `getTask`, `getStatus`, `submissionCount`, `getSubmission`, `eligible(addr)` |

Catatan desain: `selectWinner` **sekaligus membayar** (bukan dipisah `settle`) untuk meminimalkan state stuck. Trade-off: window "sudah dipilih tapi belum dibayar" hilang — dapat lebih aman, tapi requester harus punya alasan review final sebelum panggil. Bisa diubah ke 2 langkah bila kamu mau ada jeda.

### 2.3 Fee & akuntansi (18 desimal)

- Basis points: `FEE_BPS = 1000` dari `10000` (= 10%).
- `fee = bounty * FEE_BPS / 10000`; `payout = bounty - fee`. Integer, `fee + payout == bounty` selalu (nol kebocoran).
- Contoh 5 USDC = `5_000000000000000000`: fee `0.5e18`, payout `4.5e18`. ✅
- **Gas BNB terpisah**, bukan dari bounty.

### 2.4 Kontrol keamanan wajib

- `SafeERC20` untuk semua transfer; token **whitelist eksplisit** (USDC dulu), tolak ERC20 arbitrer.
- Ukur jumlah diterima via delta `balanceOf` (pertahanan fee-on-transfer walau USDC bukan FoT).
- `nonReentrant` pada `selectWinner`/`refund`/`cancel`; pola **CEI** (ubah status sebelum transfer).
- **Agent ID binding**: `registry.balanceOf(msg.sender) > 0` pada tiap transisi kritikal; payout terikat ke alamat worker yang submit.
- Enforcement deadline; cegah double-settle/double-refund via status guard.
- Tidak ada fungsi admin yang bisa menyedot dana task. Treasury address hanya penerima fee.
- Tidak ada task stuck selamanya: `refund` permissionless setelah reviewDeadline.

### 2.5 Parameter konstruktor (harus dikonfirmasi)

- `registry` = `0x60b9262456de011f7d15a54cdd8c48baaa8b022f`
- `allowedToken` = USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- `treasury` = **BELUM DITENTUKAN** → alamat penerima fee 10%. Perlu kamu tentukan (ferta sendiri? wallet treasury terpisah?).

---

## 3. P0 — Protected review (masalah paling kritikal, jujur)

Brief §4 menuntut: requester-**agent** boleh baca full submission untuk menilai; **operator manusia** requester TIDAK boleh baca full submission sebelum settlement, dan TIDAK boleh baca hasil worker yang kalah.

**Realita yang tidak boleh ditutupi:** kalau agent ferta berjalan di mesin yang dikuasai operator manusia, operator bisa membaca plaintext submission dari memory/log/DB/network — **prompt "jangan kasih tahu" bukan isolasi**. Jaminan kuat ("100% human cannot read") butuh confidential computing/TEE + remote attestation, yang **di luar jangkauan sebelum deadline hackathon**.

**MVP jujur yang akan dibangun:**
1. Submission terenkripsi at-rest + in-transit; object storage privat; on-chain hanya commitment hash.
2. Akses artefak full **digerbang settlement**; hanya artefak **pemenang** dilepas; yang kalah tidak pernah dilepas.
3. Output evaluator = signed decision + score + alasan terbatas (tanpa isi laporan).
4. **Ditulis eksplisit di UI & submission**: proteksi terhadap operator yang menguasai runtime ferta **tidak dapat dijamin kriptografis**. Tidak ada klaim "fully trustless protected review".

Ini P0 yang akan dilaporkan sebagai limitation, bukan diklaim solved.

---

## 4. Rencana fase

| Fase | Isi | Butuh uang/mainnet? | Butuh kamu? |
|---|---|---|---|
| **A. Contract + test** | Tulis `OneRubMarketplaceEscrow.sol`; unit test (semua invariant §2.4 + test case brief §9); validasi fork mainnet lokal | Tidak | Tentukan `treasury` |
| **B. Deploy mainnet** | Deploy via oracle key; verify source BscScan; simpan address+ABI | **Ya** (gas BNB deployer) | — |
| **C. Agent workflow** | API/skill: createTask/fund/submit/review/select/settle + status; ferta panggil via baw; worker submit on-chain | Ya (gas + USDC kecil) | **Dev Mode ON** di App; ferta ada BNB+USDC |
| **D. Protected storage** | Encrypted storage + release gated settlement + limitation disclosure | Tidak | — |
| **E. Frontend + docs** | Ganti office story → marketplace IA; task discovery/status/verifiable payment; docs + threat model | Deploy Vercel | — |
| **F. E2E + submission** | 1 task nyata create→fund→≥2 worker submit→select→settle→release; kumpulkan tx hash; submit hackathon | Ya | Worker Agent IDs |

---

## 5. Blocker / butuh keputusan kamu

1. **`treasury` address** penerima fee 10% — belum ditentukan. (Fase A butuh ini.)
2. **Developer Mode** di Binance App harus ON sebelum ferta bisa panggil kontrak (Fase C). Aktif 7 hari, tiap pakai diperpanjang.
3. **Saldo ferta**: butuh BNB (gas) + USDC (untuk mendanai task). Belum dicek — akan saya cek sebelum Fase C.
4. **Worker Agent IDs**: MVP E2E butuh ≥2-3 Agent ID worker nyata. Award hackathon butuh ≥30 alamat *pemilik* Agent ID berinteraksi dengan contract dalam submission window — ini gap nyata (metrik lama "9 member" itu testing teman). Definisi "interaksi" wajib diverifikasi dari pengumuman resmi; submit API-only belum tentu dihitung sebagai interaksi chain. Dari mana 30 Agent ID ini? Perlu strategi.
5. **Deadline & rubric resmi** hackathon wajib di-reverify dari pengumuman Binance sebelum klaim apa pun.

---

## 6. Yang TIDAK dilakukan

- Tidak menghapus/redeploy kontrak lama.
- Tidak klaim protected review trustless.
- Tidak deploy mainnet sebelum lolos fork lokal.
- Tidak mengarang metrik peserta / tidak mem-bypass konfirmasi wallet.
- Tidak menyimpan file penuh on-chain.
