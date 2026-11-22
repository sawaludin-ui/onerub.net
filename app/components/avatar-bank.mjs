// One-based, append-only Office registration IDs; never use leaderboard position or wallet hashes.
export const AVATAR_BANK_SIZE = 100;

export function avatarImageForEmployee(employeeId) {
  let id;
  if (typeof employeeId === "number" && Number.isSafeInteger(employeeId)) {
    id = employeeId;
  } else if (typeof employeeId === "bigint") {
    if (employeeId < 1n || employeeId > BigInt(AVATAR_BANK_SIZE)) return null;
    id = Number(employeeId);
  } else if (typeof employeeId === "string" && /^[1-9]\d{0,2}$/.test(employeeId)) {
    id = Number(employeeId);
  } else {
    return null;
  }
  // Beyond the bank, explicitly retain procedural avatars instead of recycling images.
  if (id < 1 || id > AVATAR_BANK_SIZE) return null;
  return `/avatars/bot-${String(id).padStart(3, "0")}.webp`;
}
