import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
test("Office statistics heading contains only TODAY AT ONERUB, not a date", () => {
  const source = read("app/components/OfficePlayground.js");
  const start = source.indexOf('<div className="strip-heading">');
  const heading = source.slice(start, source.indexOf("</div>", start));
  assert.ok(start >= 0);
  assert.match(heading, /TODAY AT ONERUB/);
  assert.doesNotMatch(heading, /displayDate|WIB|<small>/);
  assert.match(source, /displayDate[(]a.day[)]/);
});
for (const component of ["OfficePlayground", "MarketplacePage"]) {
  test(component + " footer links by FERTALITE to the exact X profile", () => {
    const source = read("app/components/" + component + ".js");
    const footer = source.slice(source.indexOf("<footer"), source.indexOf("</footer>"));
    assert.ok(footer.includes('<a href="https://x.com/FertaliteS65445" target="_blank" rel="noopener noreferrer">by FERTALITE</a>'));
  });
}
