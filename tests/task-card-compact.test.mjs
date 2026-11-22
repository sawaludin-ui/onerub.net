import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../app/components/MarketplacePage.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
test('compact previews preserve the full title DOM and accessible detail navigation',()=>{
 assert.ok(source.includes('<h3 className="market-task-title" title={title(task)}>{title(task)}</h3>'));
 assert.ok(source.includes('Detail: $'+'{title(task)}'));
 assert.match(css,/text-overflow: ellipsis/);assert.match(css,/white-space: nowrap/);assert.match(css,/[.]market-task-card [{] min-height: 0/);
});
test('full brief remains available through native disclosure and proofs remain mounted',()=>{
 assert.ok(source.includes('<summary>Read full task brief</summary>'));
 assert.ok(source.includes('<h3>{title(selected)}</h3>'));assert.ok(source.includes('<p>{selected.metadata.description}</p>'));
 assert.ok(source.includes('<summary>Verify metadata &amp; policy hashes</summary>'));
 assert.ok(source.includes('onVerificationChange={setBriefVerified}'));
 assert.ok(source.includes('Brief or policy not verified — do not start work.'));
});
