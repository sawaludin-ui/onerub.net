// Read-only public chain/API/browser verification. Fixture modes intercept only the isolated browser.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/Dimas Sawaludin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const base=process.env.PARTICIPANT_UI_BASE||'http://127.0.0.1:3017',out='artifacts/task-participant-hover';
await fs.mkdir(out,{recursive:true});
const contract='0x0D33DD09131aC17827fA165D70daAAB4DBfC299a';
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(60000)});assert.equal(r.status,200,url);return r.json();}
const initial=await json(base+'/api/marketplace/tasks/1/participants?chainId=56&escrowAddress='+contract);
assert.equal(initial.total,14);assert.equal(initial.participants.length,14);assert.equal(initial.order,'on-chain-submission-append-order');
for(const row of initial.participants)assert.deepEqual(Object.keys(row).sort(),['agentId','identityStatus','ordinal','submittedAt','wallet'].sort());
await fs.writeFile(out+'/actual-participants.json',JSON.stringify(initial,null,2));
const reports=[],browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const name=row=>row.agentId||row.wallet.slice(0,6)+'…'+row.wallet.slice(-4);
async function expectSelection(page,row){await page.waitForFunction(expected=>document.querySelector('[data-agent-label]')?.textContent===expected,name(row),{timeout:60000});const hint=page.locator('[data-participant-hint]');assert.ok((await hint.innerText()).includes('Submission #'+row.ordinal));assert.ok((await hint.innerText()).includes(row.wallet));return hint;}
try{
 for(const width of [320,390,768,1440,1920]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],httpErrors=[];let reads=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});});page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('/participants'))reads++;});
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:120000});const card=page.locator('[data-task-stats-card]').first();await card.getByText('Worker',{exact:true}).waitFor({timeout:60000});assert.equal(reads,0,'no participant RPC without interest');const buttons=card.locator('button[data-active="true"]');assert.equal(await buttons.count(),14);
  const incoming=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/participants'));await buttons.first().hover();const response=await incoming;assert.equal(response.status(),200);const live=await response.json();
  for(let i=0;i<live.total;i++){await buttons.nth(i).hover();await expectSelection(page,live.participants[i]);}
  const hint=await expectSelection(page,live.participants.at(-1));await hint.hover();assert.equal(await hint.isVisible(),true,'hover can enter the hint');await page.keyboard.press('Escape');assert.equal(await page.locator('[data-participant-hint]').count(),0,'Escape dismisses pointer-only hint');
  await buttons.first().focus();await expectSelection(page,live.participants[0]);await page.keyboard.press('ArrowRight');await expectSelection(page,live.participants[1]);await page.keyboard.press('End');await expectSelection(page,live.participants.at(-1));await page.keyboard.press('Home');await expectSelection(page,live.participants[0]);
  await card.screenshot({path:out+'/hover-'+width+'.png',animations:'disabled'});assert.equal(reads,1,'hover and keyboard share a single cached fetch');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);
  await page.keyboard.press('Escape');const detail=card.getByRole('link',{name:/^Detail:/});await detail.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('dialog[open] .task-detail-title')?.textContent.includes('Teka-Teki'),{},{timeout:60000});await page.keyboard.press('Escape');await page.waitForURL(u=>u.hash==='#tasks');
  reports.push({case:'actual-wallets',width,names:live.participants.map(name),reads,all14Hover:true,keyboard:true,escape:true,hoverableHint:true,detail:true,pageerrors:errors,httpErrors});await context.close();
 }
 {const context=await browser.newContext({viewport:{width:390,height:1000},hasTouch:true,isMobile:true,reducedMotion:'reduce'}),page=await context.newPage();await page.goto(base,{waitUntil:'domcontentloaded'});const buttons=page.locator('[data-task-stats-card] button[data-active="true"]');await buttons.nth(1).tap();await expectSelection(page,initial.participants[1]);await page.touchscreen.tap(3,3);assert.equal(await page.locator('[data-participant-hint]').count(),0);reports.push({case:'touch-tap',passed:true});await context.close();}
 {const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();await page.goto(base,{waitUntil:'domcontentloaded'});const button=page.locator('[data-task-stats-card] button[data-active="true"]').nth(4);await button.hover();await expectSelection(page,initial.participants[4]);assert.ok((await page.locator('[data-task-stats-card]').first().getAttribute('style')).includes('rotateX'));await page.waitForFunction(()=>[...document.querySelectorAll('button[data-active="true"]')].some(el=>getComputedStyle(el).scale.includes('1.1')));reports.push({case:'original-3d-and-bar-animation',passed:true});await context.close();}
 for(const mode of ['unknown-registry','rpc-error']){
  const context=await browser.newContext({viewport:{width:390,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
  await page.route('**/participants?**',route=>{if(mode==='rpc-error')return route.fulfill({status:503,json:{code:'PARTICIPANTS_UNAVAILABLE'}});const data=structuredClone(initial);data.participants[0].agentId=null;data.participants[0].identityStatus='unknown';return route.fulfill({json:data});});
  await page.goto(base,{waitUntil:'domcontentloaded'});const button=page.locator('[data-task-stats-card] button[data-active="true"]').first();await button.hover();if(mode==='unknown-registry'){const row={...initial.participants[0],agentId:null};await expectSelection(page,row);assert.ok((await page.locator('[data-participant-hint]').innerText()).includes('temporarily unavailable'));}else{await page.waitForFunction(()=>document.querySelector('[data-agent-label]')?.textContent==='Participants unavailable');assert.equal(await button.getAttribute('data-agent-wallet'),null);}
  reports.push({case:mode,fixtureOnly:true,passed:true});await context.close();
 }
 // Future-task fixtures are browser-only: no real task, wallet, or transaction is created.
 {
  const market=await json(base+'/api/marketplace?limit=12'),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();let reads=0;
  const future={...market.tasks.find(t=>t.id==='1'),id:'2',submissionCount:64};
  const payload={...initial,taskId:'2',total:64,participants:Array.from({length:64},(_,i)=>({ordinal:i+1,wallet:'0x'+(64-i).toString(16).padStart(40,'0'),agentId:'future-fixture-'+(i+1)+'.ai',identityStatus:'resolved',submittedAt:initial.participants[0].submittedAt}))};
  await page.route('**/api/marketplace**',route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/marketplace')return route.fulfill({json:{...market,tasks:[future]}});if(path==='/api/marketplace/tasks/2/participants'){reads++;return route.fulfill({json:payload});}return route.continue();});
  await page.goto(base,{waitUntil:'domcontentloaded'});const buttons=page.locator('[data-task-stats-card] button[data-active="true"]');await buttons.first().waitFor();assert.equal(await buttons.count(),64);await buttons.first().focus();await expectSelection(page,payload.participants[0]);await page.keyboard.press('End');await expectSelection(page,payload.participants[63]);assert.equal(reads,1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);reports.push({case:'future-task64-browser-fixture',fixtureOnly:true,passed:true});await context.close();
 }
 {
  const market=await json(base+'/api/marketplace?limit=12'),source=market.tasks.find(t=>t.id==='1'),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();let count=14,reads=0,releaseOld;
  const oldGate=new Promise(resolve=>releaseOld=resolve);
  const fresh={...structuredClone(initial),total:15};fresh.participants[0].agentId='fresh-count-fixture.ai';fresh.participants.push({ordinal:15,wallet:'0x'+'a'.repeat(40),agentId:'extra-fixture.ai',identityStatus:'resolved',submittedAt:initial.participants.at(-1).submittedAt});
  await page.route('**/api/marketplace**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/marketplace')return route.fulfill({json:{...market,tasks:[{...source,submissionCount:count}]}});if(path.endsWith('/participants')){reads++;if(reads===1){await oldGate;return route.fulfill({json:initial});}return route.fulfill({json:fresh});}return route.continue();});
  try{await page.goto(base,{waitUntil:'domcontentloaded'});const first=page.locator('[data-task-stats-card] button[data-active="true"]').first();await first.hover();await page.waitForFunction(()=>document.querySelector('[data-agent-label]')?.textContent.includes('Loading'));
   count=15;await page.getByRole('button',{name:'Refresh marketplace',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-task-stats-card] button[data-active="true"]').length===15);await first.hover();await expectSelection(page,fresh.participants[0]);const older=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/participants'));releaseOld();const oldResponse=await older;await oldResponse.finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expectSelection(page,fresh.participants[0]);assert.equal(reads,2);reports.push({case:'late-response-does-not-overwrite-new-count',fixtureOnly:true,passed:true});
  }finally{releaseOld();await context.close();}
 }
}finally{await browser.close();}
await fs.writeFile(out+'/browser-results.json',JSON.stringify({base,passed:true,cases:reports.length,orderBasis:'on-chain append order; not work start',reports},null,2));console.log(JSON.stringify({passed:true,cases:reports.length,out}));
