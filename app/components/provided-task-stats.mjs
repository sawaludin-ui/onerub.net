// Original ZIP color interpolation and segment building; numeric bounds guard missing API data.
const SPECTRUM_STOPS = [
  [10, 132, 255],  // #0A84FF vivid blue
  [79, 92, 245],   // #4F5CF5 indigo
  [147, 83, 211],  // #9353D3 purple
  [217, 70, 178],  // #D946B2 magenta pink
  [244, 114, 92],  // #F4725C coral orange
];

const INACTIVE_SEGMENT_COLOR = '#38383A';

function interpolateRgb(
  start,
  end,
  t
) {
  const r = Math.round(start[0] + (end[0] - start[0]) * t);
  const g = Math.round(start[1] + (end[1] - start[1]) * t);
  const b = Math.round(start[2] + (end[2] - start[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

export function getSpectrumColor(activeIndex, activeTotal) {
  if (activeTotal <= 1) {
    const [r, g, b] = SPECTRUM_STOPS[0];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const normalized = Math.min(1, Math.max(0, activeIndex / (activeTotal - 1)));
  const scaled = normalized * (SPECTRUM_STOPS.length - 1);
  const lowerIdx = Math.floor(scaled);
  const upperIdx = Math.min(SPECTRUM_STOPS.length - 1, lowerIdx + 1);
  const localT = scaled - lowerIdx;
  return interpolateRgb(SPECTRUM_STOPS[lowerIdx], SPECTRUM_STOPS[upperIdx], localT);
}

export function buildAvailabilitySegments(
  agentsEntered,
  totalSlots
) {
  const safeTotal = Number.isFinite(totalSlots) ? Math.max(1, Math.min(64, Math.floor(totalSlots))) : 30;
  const safeActive = Number.isFinite(agentsEntered) ? Math.min(safeTotal, Math.max(0, Math.floor(agentsEntered))) : 0;

  return Array.from({ length: safeTotal }, (_, index) => {
    const isActive = index < safeActive;
    return {
      index,
      isActive,
      color: isActive ? getSpectrumColor(index, safeActive) : INACTIVE_SEGMENT_COLOR,
    };
  });
}

export function formatAgentCountLabel(agentsEntered) {
  const count = Math.max(0, Math.floor(agentsEntered));
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

export function extractTaskDigits(taskIdentifier) {
  const digits = taskIdentifier.replace(/\D/g, '');
  return digits || taskIdentifier.trim();
}
