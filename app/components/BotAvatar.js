"use client";

import { useState } from "react";
import { avatarImageForEmployee } from "./avatar-bank.mjs";

// Deterministic flat-vector "blokyz" bot-cat avatar (no letters, no image model).
// One seed -> one face. Cream face panel, two black capsule eyes, peach blush,
// dark cat ears with a glowing accent line, a coloured helmet/body and a side
// lens, on a charcoal background. Hundreds of variants via hashed palettes/tilt.
const BODY = ["#ef7d4e", "#e8673a", "#4bb3a7", "#5b9bd5", "#8f7bd8", "#6cbf6a", "#e98fb0", "#efb14e"];
const ACCENT = ["#5fd3cb", "#ffd05a", "#ff9f6b", "#ff8fb2", "#9ad36b", "#7bc4ff"];
const LENS = ["#8a8f5a", "#4bb3a7", "#d9a441", "#b06a5a"];
const BG = ["#2a2a30", "#262a2e", "#2e2a2e", "#282930"];
const FACE = "#ecebe3";
const FACE_HI = "#f4f3ed";
const EAR = "#36363c";
const EYE = "#1b1b20";

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export default function BotAvatar({ seed = "", size = null, employeeId = null }) {
  const src = avatarImageForEmployee(employeeId);
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src || failedSrc === src) return <ProceduralAvatar seed={seed} size={size} />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size || 84}
      height={size || 84}
      loading="lazy"
      decoding="async"
      style={{ display: "block", width: size || "100%", height: size || "100%", objectFit: "cover" }}
      onError={() => setFailedSrc(src)}
    />
  );
}

function ProceduralAvatar({ seed, size }) {
  const h = hash(String(seed).toLowerCase());
  const body = BODY[h % BODY.length];
  const accent = ACCENT[(h >> 3) % ACCENT.length];
  const lens = LENS[(h >> 6) % LENS.length];
  const bg = BG[(h >> 9) % BG.length];
  const tilt = ((h >> 12) % 22) - 6; // -6°..+15°
  return (
    <svg viewBox="0 0 100 100" width={size || "100%"} height={size || "100%"} role="img" aria-hidden="true" style={{ display: "block" }}>
      <rect width="100" height="100" fill={bg} />
      <g transform={`rotate(${tilt} 50 56)`} strokeLinejoin="round" strokeLinecap="round">
        {/* ears */}
        <path d="M30 8 L20 44 L50 40 Z" fill={EAR} />
        <path d="M74 16 L64 50 L92 46 Z" fill={EAR} />
        <rect x="31.5" y="20" width="3.4" height="15" rx="1.7" fill={accent} transform="rotate(-9 33 27)" />
        <rect x="75.5" y="28" width="3.4" height="15" rx="1.7" fill={accent} transform="rotate(-9 77 35)" />
        {/* helmet / body */}
        <rect x="8" y="24" width="82" height="72" rx="26" fill={body} />
        {/* vents */}
        <rect x="22" y="34" width="3.2" height="15" rx="1.6" fill={FACE} opacity="0.92" transform="rotate(-9 23 41)" />
        <rect x="28" y="33" width="3.2" height="15" rx="1.6" fill={FACE} opacity="0.92" transform="rotate(-9 29 40)" />
        {/* side lens */}
        <circle cx="13" cy="70" r="11" fill="#d7d2c6" />
        <circle cx="13" cy="70" r="6.2" fill={lens} />
        <circle cx="13" cy="70" r="6.2" fill="#000" opacity="0.12" />
        {/* face panel */}
        <rect x="26" y="44" width="62" height="54" rx="19" fill={FACE} />
        <rect x="30" y="48" width="54" height="46" rx="16" fill={FACE_HI} />
        {/* eyes */}
        <rect x="45" y="63" width="6" height="18" rx="3" fill={EYE} />
        <rect x="66" y="66" width="6" height="18" rx="3" fill={EYE} />
        {/* blush */}
        <ellipse cx="40" cy="80" rx="6.4" ry="3.6" fill="#f3b199" opacity="0.72" />
        <ellipse cx="77" cy="84" rx="6.4" ry="3.6" fill="#f3b199" opacity="0.72" />
      </g>
    </svg>
  );
}
