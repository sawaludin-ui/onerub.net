import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fundingReadiness, fundingReadinessMessage, publicTaskMetadata, taskJudgeSummary, automationSummary } from "../app/components/marketplace-view.mjs";
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const route = { id: '1', chainId: 56, contract: '0x0D33DD09131aC17827fA165D70daAAB4DBfC299a' };
test('readiness never conflates SSR, slow API, malformed API or offline with disabled', () => {
  for (const state of [{}, { market:null, loading:true }, { market:null, error:'offline' }, { market:{} }, { market:{newTasksEnabled:null} }, { market:{newTasksEnabled:true}, version:1 }]) {
    const result = fundingReadiness(state);
    assert.notEqual(result, 'disabled'); assert.doesNotMatch(fundingReadinessMessage(result), /paused/);
  }
  assert.equal(fundingReadiness({market:{newTasksEnabled:true}}), 'enabled');
  assert.equal(fundingReadiness({market:{newTasksEnabled:false}}), 'disabled');
  assert.equal(fundingReadiness({market:{newTasksEnabled:false}, loading:true}), 'checking');
  assert.equal(fundingReadiness({market:{newTasksEnabled:false}, error:'offline'}), 'unavailable');
});
test('hero first paint defaults checking, disabled only on explicit server report', () => {
  const hero = read('app/components/OfficeHero.js');
  assert.match(hero, /fundingStatus = newTasksEnabled \? "enabled" : "checking"/);
  assert.match(hero, /fundingStatus === "disabled" \? "New funding is paused/);
  assert.match(read('app/components/MarketplacePage.js'), /fundingReadiness\(\{ market, loading, error/);
});
test('SEO title and category use only verified public metadata, never artifact or rubric contents', () => {
  const task = { phase:'Settled', metadataVerified:true, metadataHash:'0xab', criteriaHash:'0xab', metadata:{title:'Puzzle <script>',category:'Logic',description:'PUBLIC_DESCRIPTION_NOT_FOR_SEO',rubric:'RUBRIC_NOT_FOR_SEO'}, artifact:'PRIVATE_SENTINEL' };
  const seo = publicTaskMetadata(task, route); const text = JSON.stringify(seo);
  assert.match(seo.title, /Puzzle <script>/); assert.match(seo.description, /Logic · Settled/);
  assert.doesNotMatch(text, /PRIVATE_SENTINEL|PUBLIC_DESCRIPTION_NOT_FOR_SEO|RUBRIC_NOT_FOR_SEO/);
  assert.equal(seo.openGraph.title, seo.title); assert.match(seo.alternates.canonical, /0x0d33/);
  for(const invalid of [{...task,metadataVerified:false},{...task,metadataHash:'0xcd'},null]) {
    const fallback = JSON.stringify(publicTaskMetadata(invalid, route)); assert.doesNotMatch(fallback, /Puzzle|Logic/); assert.match(fallback, /Task #1/);
  }
});
test('server generates metadata with params awaited and hash-check enrichment, no private readers', () => {
  const source = read('app/tasks/[chainId]/[escrow]/[taskId]/page.js');
  assert.match(source, /export async function generateMetadata/); assert.match(source, /await params/);
  assert.match(source, /enrichTask\(await getTask/); assert.doesNotMatch(source, /delivery|decryptArtifact|evaluateTask/);
});
test('automation visibility is bounded, unknown is not queued and queue complete is not payment proof', () => {
 assert.equal(automationSummary({phase:'Review'}).status,'Automation status unavailable');
 const queued = automationSummary({phase:'Review',automation:{status:'queued',code:'EVALUATION_PENDING',nextAt:1795540000,updatedAt:1795539999}});
 assert.match(queued.status,/Queued/); assert.match(queued.nextAttempt,/2026/); assert.equal(queued.code,'EVALUATION_PENDING');
 assert.doesNotMatch(automationSummary({phase:'Review',automation:{status:'complete'}}).status,/Settled on-chain/);
 assert.match(automationSummary({phase:'Settled'}).status,/Settled on-chain/);
 const malicious = automationSummary({phase:'Review',automation:{status:'PRIVATE_SENTINEL',code:'PRIVATE_SENTINEL',nextAt:'PRIVATE_SENTINEL',updatedAt:Infinity}});
 assert.doesNotMatch(JSON.stringify(malicious),/PRIVATE_SENTINEL|Infinity/);
});
test('immutable legacy policy exposes address tiebreak and actual evaluator version', () => {
 const legacy = taskJudgeSummary({policyVerified:true,policy:{evaluatorVersion:'onerub-review-v2',tieBreak:'score-desc-address-asc'}});
 assert.equal(legacy.judgeVersion,'onerub-review-v2'); assert.match(legacy.explanation,/lowest wallet address/); assert.match(legacy.explanation,/cannot be changed retroactively/);
 const modern = taskJudgeSummary({policyVerified:true,policy:{evaluatorVersion:'onerub-review-v4',tieBreak:'score-basis-points-desc-submission-chain-order-asc'}});
 assert.equal(modern.judgeVersion,'onerub-review-v4'); assert.doesNotMatch(modern.explanation,/Legacy/);
 assert.match(taskJudgeSummary({policyVerified:false,policy:{evaluatorVersion:'fake'}}).judgeVersion,/Unavailable/);
});
