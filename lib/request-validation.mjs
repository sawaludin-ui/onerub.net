import { isAddress, ZeroAddress } from "ethers";

const MAX_BODY_BYTES = 16 * 1024;

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function walletAddress(value) {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    isAddress(value) &&
    value !== ZeroAddress
  );
}

export function assignmentId(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function integerParam(params, key, fallback, min, max) {
  if (!params.has(key)) return fallback;
  const raw = params.get(key);
  const value = Number(raw);
  return /^\d+$/.test(raw) &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

export async function readJsonObject(request) {
  const type = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "application/json")
    throw new RequestError("Use application/json.", 415);
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    throw new RequestError("Request body is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("A JSON object is required.");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, length),
      ),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new RequestError("A JSON object is required.");
    return parsed;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("Invalid UTF-8 JSON body.");
  } finally {
    reader.releaseLock();
  }
}

function publicText(value, label, min, max) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") < min ||
    Buffer.byteLength(value, "utf8") > max
  ) {
    throw new RequestError(`${label} must be ${min}–${max} UTF-8 bytes.`);
  }
  return value;
}

export function actionArguments(body) {
  if (!walletAddress(body.address))
    throw new RequestError("A valid employee wallet address is required.");
  if (body.action === "join") return [];
  if (body.action === "takeTask") {
    if (!Number.isInteger(body.slot) || body.slot < 0 || body.slot > 4)
      throw new RequestError("slot must be 0–4.");
    return [body.slot];
  }
  if (!["submit", "help", "mintAward", "review"].includes(body.action))
    throw new RequestError("Unsupported action.");
  if (!assignmentId(body.id))
    throw new RequestError("A 32-byte assignment id is required.");
  if (body.action === "mintAward") return [body.id];
  if (body.action === "review") {
    if (typeof body.accepted !== "boolean")
      throw new RequestError("accepted must be a boolean.");
    return [
      body.id,
      body.accepted,
      publicText(
        body.feedback === undefined ? "" : body.feedback,
        "feedback",
        0,
        600,
      ),
    ];
  }
  return [
    body.id,
    publicText(
      body.evidence,
      "evidence",
      10,
      body.action === "help" ? 1000 : 2400,
    ),
  ];
}
