import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parse } = require("next/dist/compiled/babel/parser");
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("edited Next components and dynamic task pages parse with JSX", () => {
  for (const path of ["app/components/OfficeHero.js", "app/components/OfficeNav.js", "app/components/OfficeDialog.js", "app/components/PlaygroundHero.js", "app/components/MarketplacePage.js", "app/permissions/page.js", "app/tasks/page.js", "app/tasks/[chainId]/[escrow]/[taskId]/page.js", "app/tasks/[chainId]/[escrow]/[taskId]/not-found.js"]) {
    assert.doesNotThrow(() => parse(read(path), {sourceType:"module", plugins:["jsx"]}), path);
  }
});
test("hero presents distinct role decisions and economic risk before sculpture", () => {
  const hero = read("app/components/OfficeHero.js");
  assert.match(hero, /disabled=\{!newTasksEnabled\}/);
  assert.match(hero, /Post &amp; fund a task/);
  assert.match(hero, /New funding is paused while V2 is being verified/);
  assert.match(hero, /onClick=\{onWorker\}>Find work for my agent/);
  assert.match(hero, /other submissions are unpaid/);
  assert.match(hero, /without a wallet/);
  assert.ok(hero.indexOf("hero-risk") < hero.indexOf("<OfficeSculpture"));
});
test("trust navigation and Playground clearly distinguish public demo from marketplace", () => {
  const nav = read("app/components/OfficeNav.js");
  assert.match(nav, /Trust & contracts/);
  assert.match(nav, /Developer docs/);
  const playground = read("app/components/PlaygroundHero.js");
  assert.match(playground, /OFFICE DEMO · PUBLIC WORK · NO BOUNTY/);
  assert.match(playground, /use BNB gas/);
  assert.match(read("app/components/MarketplacePage.js"), /href="\/security.md"/);
});
test("dynamic task routes await params and never alias another escrow", () => {
  const route = read("app/tasks/[chainId]/[escrow]/[taskId]/page.js");
  assert.match(route, /await params/);
  assert.match(route, /matchesDeployment/);
  assert.match(route, /notFound\(\)/);
  const page = read("app/components/MarketplacePage.js");
  assert.match(page, /escrowAddress=\$\{contract\}/);
  assert.match(page, /disabled=\{detailLoading \|\| !!detailError\}/);
  assert.match(page, /Copied only. No agent connected/);
});
test("dialog explicitly wraps forward and reverse Tab at focus boundaries", () => {
 const source=read("app/components/OfficeDialog.js");
 assert.match(source,/event.key !== "Tab"/);
 assert.match(source,/event.shiftKey && document.activeElement === first/);
 assert.match(source,/!event.shiftKey && document.activeElement === last/);
 assert.match(source,/last.focus\(\)/);
 assert.match(source,/first.focus\(\)/);
});
