// Local avatar selection/render tests; no network or generated asset stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_BANK_SIZE, avatarImageForEmployee } from "../app/components/avatar-bank.mjs";
import { readRoster } from "../lib/chain.mjs";

const require = createRequire(import.meta.url);
const avatarSource = readFileSync(new URL("../app/components/BotAvatar.js", import.meta.url), "utf8");
const { code } = require("next/dist/build/swc").transformSync(avatarSource, {
  filename: "BotAvatar.js",
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});

// Isolate the one hook to exercise image-error state without a browser/server/build.
function componentHarness() {
  let state = null;
  const exports = {};
  runInNewContext(code, { exports, require(name) {
    if (name === "react") return { useState: () => [state, (value) => { state = value; }] };
    if (name === "./avatar-bank.mjs") return { avatarImageForEmployee };
    return require(name);
  } });
  return exports.default;
}

test("first AVATAR_BANK_SIZE registration IDs get exactly AVATAR_BANK_SIZE unique ordered image paths", () => {
  const paths = Array.from({ length: AVATAR_BANK_SIZE }, (_, i) => avatarImageForEmployee(i + 1));
  assert.equal(paths.length, AVATAR_BANK_SIZE);
  assert.equal(new Set(paths).size, AVATAR_BANK_SIZE);
  paths.forEach((path, i) => assert.equal(path, `/avatars/bot-${String(i + 1).padStart(3, "0")}.webp`));
});

test("JSON and bigint registration ID forms agree", () => {
  for (let id = 1; id <= AVATAR_BANK_SIZE; id++) {
    assert.equal(avatarImageForEmployee(String(id)), avatarImageForEmployee(id));
    assert.equal(avatarImageForEmployee(BigInt(id)), avatarImageForEmployee(id));
  }
});

test("missing, malformed and out-of-bank IDs explicitly choose procedural fallback", () => {
  for (const id of [undefined, null, "", 0, -1, AVATAR_BANK_SIZE+1, 200, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0n, 101n, 10n ** 100n, "0", "01", "001", "1.0", "1e2", " 1", "+1", "0x01", "101", "0xabc", {}, [], true]) {
    assert.equal(avatarImageForEmployee(id), null, String(id));
  }
});

test("append-only onchain roster order survives paging, identity errors and score sorting", async () => {
  const addresses = Array.from({ length: 103 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`);
  const contract = {
    getEmployeeAddresses: async (start, limit) => addresses.slice(start, start + limit),
    employees: async (address) => ({ joined: true, rank: 0, stageCorrect: 0, totalCorrect: Number(address.slice(-3)), internStreak: 0, joinedAt: 1 }),
  };
  const identity = { handleOf: async () => { throw Error("No handle"); } };
  const roster = await readRoster(contract, identity, addresses.length, {});
  assert.deepEqual(roster.map((e) => e.address), addresses);
  const directory = new Map(roster.map((e, i) => [e.address.toLowerCase(), { ...e, employeeNumber: i + 1 }]));
  const before = new Map(roster.map((e) => [e.address, avatarImageForEmployee(directory.get(e.address).employeeNumber)]));
  for (const e of roster.slice().sort((a, b) => b.totalCorrect - a.totalCorrect)) {
    assert.equal(avatarImageForEmployee(directory.get(e.address).employeeNumber), before.get(e.address));
  }
  assert.equal(before.get(addresses[AVATAR_BANK_SIZE-1]), "/avatars/bot-055.webp");
  assert.equal(before.get(addresses[100]), null);
});

test("Office passes registration directory number rather than score-sorted map index", () => {
  const source = readFileSync(new URL("../app/components/OfficePlayground.js", import.meta.url), "utf8");
  assert.ok(source.includes("employeeId={directory.get(e.address.toLowerCase()).employeeNumber}"));
  assert.ok(source.includes("employeeNumber: i + 1"));
});

test("valid ID renders decorative bank image with original sizing", () => {
  const Avatar = componentHarness();
  const element = Avatar({ employeeId: 37, seed: "0xabc", size: 84 });
  assert.equal(element.type, "img");
  assert.equal(element.props.src, "/avatars/bot-037.webp");
  assert.equal(element.props.width, 84);
  assert.equal(element.props.height, 84);
  assert.equal(element.props.loading, "lazy");
  assert.equal(element.props.decoding, "async");
  assert.equal(element.props.alt, "");
  assert.equal(element.props["aria-hidden"], "true");
});

test("image error uses existing SVG, changes to another ID can load that image", () => {
  const Avatar = componentHarness();
  const props = { employeeId: 1, seed: "0xabc", size: 84 };
  Avatar(props).props.onError();
  const fallback = renderToStaticMarkup(Avatar(props));
  assert.match(fallback, /^<svg /);
  assert.doesNotMatch(fallback, /<img/);
  assert.equal(fallback, renderToStaticMarkup(Avatar({ ...props, employeeId: 101 })));
  assert.equal(Avatar({ ...props, employeeId: 2 }).props.src, "/avatars/bot-002.webp");
});

test("legacy seed-only and overflow avatars preserve deterministic procedural output", () => {
  const Avatar = componentHarness();
  const first = renderToStaticMarkup(Avatar({ seed: "0xABC" }));
  assert.match(first, /^<svg /);
  assert.equal(first, renderToStaticMarkup(Avatar({ seed: "0xabc", employeeId: 101 })));
});
