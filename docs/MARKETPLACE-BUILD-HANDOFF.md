# ONERUB marketplace — pembagian implementasi

Konsep produk mengikuti ONERUB_AGENTIC_AI_MASTER_BRIEF.txt. Dokumen ini mengatur pelaksanaan, bukan membuka ulang keputusan produk. Pembagian berikut usulan koordinasi; belum berarti Claude menerima penugasan.

## Kontrak integrasi bersama

- Chain 56; escrow 0xb30E139eAdE49fdD8ace38FBE0C3dD97C0f5a0Ea.
- ABI dan alamat dari lib/marketplace-abi.json dan lib/marketplace-deployment.json.
- Alur: createAndFund -> submitCommitment -> protected evaluation -> selectWinner (settlement atomik 90/10) -> winning artifact delivery.
- Bounty input requester; 5 USDC hanya contoh, bukan nilai tetap.
- Task ID + chain ID + escrow address menjadi identitas task lintas API/storage/UI.
- Public API hanya metadata aman dan bukti chain. Plaintext submission tidak masuk respons publik, SSR, bundle frontend, atau log.
- Worker menerima receipt hash artefak yang tersimpan sebelum membuat commitment on-chain; ciphertext dan commitment diverifikasi konsisten.
- Delivery hanya sesudah receipt sukses dan konfirmasi chain yang ditentukan; requester sah hanya memperoleh artefak pemenang. Reorg/pending tidak dianggap paid.
- Requester evaluator berjalan pada layanan terpisah dari runtime requester; tidak mengirim raw laporan ke runtime requester. Batas kepercayaan host/model provider harus dinyatakan.
- Signed evaluator decision mengikat task, daftar commitment, pemenang, rubric hash, expiry. Kontrak sekarang belum memverifikasi signature evaluator: enforcement ini berada di workflow aplikasi, bukan jaminan on-chain.

## Pembagian agar tidak saling menimpa

Claude: contracts/, scripts/agent-task.mjs, backend marketplace, authenticated submission/storage/evaluator/delivery, pengujian integrasi backend. Perubahan kontrak baru hanya setelah kebutuhan konkret terbukti.

Codex: frontend marketplace, task discovery/detail/status, tampilan fee dan net payout, dokumentasi publik/skill/permissions, pengujian UI serta integrasi akhir. Pertahankan animasi dari ZIP yang disetujui.

Satu penanggung jawab per file. Gunakan branch/worktree terpisah, sepakati schema API sebelum frontend terhubung, dan satu integrator untuk deploy produksi. Tidak menjalankan dua deploy produksi bersamaan.

## Urutan kerja

1. Bekukan schema task/submission/evaluation/delivery dan contoh respons untuk open, empty, pending, settled, failed. Pilih storage privat persisten dan evaluator berdasarkan konfigurasi yang tersedia; jangan memakai filesystem sementara Vercel untuk data persisten.
2. Bangun satu alur lengkap di lokal/fork: task funded, dua worker, private artifacts, evaluasi, winner, payout, gated delivery. Pakai adapter mock hanya pada pengujian dan tandai jelas; jangan tampilkan sebagai aktivitas nyata.
3. Hubungkan frontend dan agent skill ke API baru; hapus office gamification dari alur utama. Legacy tetap terpisah dan datanya dipertahankan.
4. Uji unauthorized access, replay, content tampering, losing artifact access, failed storage, timeout/refund, prompt injection, pending/reorg, dan tidak ada plaintext dalam output evaluator.
5. Deploy preview, verifikasi browser dan API, lalu produksi melalui satu integrator. Demo mainnet dengan Agent IDs nyata ketika saldo dan peserta tersedia; kumpulkan bukti tanpa menghambat pekerjaan sebelumnya.

## Bukti selesai

Satu alur create/fund -> >=2 submissions -> evaluator decision -> payout 90/10 -> winner delivery, dengan test output dan tx receipts yang membedakan fork dari mainnet. Tidak ada klaim isolasi terhadap host tanpa implementasi dan bukti. Belum ada komunikasi atau penugasan otomatis ke sesi Claude dari dokumen ini.
