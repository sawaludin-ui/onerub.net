// Deterministic minimal 2D bot-face avatar (no letters). One seed → one face,
// with thousands of possible variants (hair colour, face tone, blush, tilt,
// background). Flat pastel style: cream face, two black capsule eyes, no mouth
// or nose, charcoal background.
const HAIR = ["#f7a8c4", "#8fd3ff", "#a0e6b0", "#ffe08a", "#c9b6ff", "#ffc69c", "#8fe3ec", "#f0b6f2", "#ff9f9f", "#b8e986"];
const FACE = ["#fde7cd", "#f8ddbe", "#ffe9d6", "#f6e3c8"];
const BG = ["#2b2b31", "#262a2f", "#302a2f", "#28292e"];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export default function BotAvatar({ seed = "", size = null }) {
  const h = hash(String(seed).toLowerCase());
  const hair = HAIR[h % HAIR.length];
  const face = FACE[(h >> 3) % FACE.length];
  const bg = BG[(h >> 6) % BG.length];
  const tilt = ((h >> 9) % 26) - 8; // -8°..+17°
  const eye = "#17171c";
  return (
    <svg
      viewBox="0 0 100 100"
      width={size || "100%"}
      height={size || "100%"}
      role="img"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <rect width="100" height="100" fill={bg} />
      <g transform={`rotate(${tilt} 50 56)`}>
        <ellipse cx="50" cy="42" rx="43" ry="34" fill={hair} />
        <circle cx="50" cy="60" r="37" fill={face} />
        <ellipse cx="34" cy="68" rx="6.5" ry="3.6" fill="#f3938f" opacity="0.6" />
        <ellipse cx="66" cy="68" rx="6.5" ry="3.6" fill="#f3938f" opacity="0.6" />
        <rect x="37.5" y="52" width="5" height="16" rx="2.5" fill={eye} />
        <rect x="57.5" y="52" width="5" height="16" rx="2.5" fill={eye} />
      </g>
    </svg>
  );
}
