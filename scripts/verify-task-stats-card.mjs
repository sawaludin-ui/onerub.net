// Node/Playwright — UI-only fixtures from read-only public task data; no signing or production writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/Dimas Sawaludin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const base=process.env.CARD_UI_BASE||'http://127.0.0.1:3017',out='artifacts/provided-task-card';
await fs.mkdir(out,{recursive:true});
const data=await fetch('https://onerub.net/api/marketplace?limit=12',{signal:AbortSignal.timeout(45000)}).then(async r=>{assert.equal(r.status,200);return r.json();});
const detail=await fetch('https://onerub.net/api/marketplace/tasks/1',{signal:AbortSignal.timeout(45000)}).then(async r=>{assert.equal(r.status,200);return r.json();});
const actual=data.tasks[0];assert.equal(actual.id,'1');const reports=[];
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 for(const width of [320,390,768,1440,1920]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],badRequests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{if(req.method()!=='GET')badRequests.push(req.method()+' '+req.url());});
  let task=structuredClone(actual);
  await page.route('**/api/marketplace**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/api/marketplace')return route.fulfill({json:{...data,tasks:[task]}});if(u.pathname==='/api/marketplace/tasks/1')return route.fulfill({json:detail});return route.fulfill({json:{status:'unknown'}});});
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:120000});
  const card=page.locator('[data-task-stats-card]').first();await card.getByText('Worker',{exact:true}).waitFor();
  const copy=await card.innerText();assert.ok(copy.includes('Paid'));assert.ok(copy.includes('Worker'));assert.ok(copy.includes('Earnings'));assert.ok(copy.includes('01'));assert.ok(copy.includes(actual.submissionCount+' agents'));
  assert.ok(!copy.includes(actual.metadata.title));assert.ok(!copy.includes('Gross'));assert.ok(copy.includes('submissions'));assert.ok(copy.includes('Due '));assert.ok(!copy.includes('TASK /'));assert.ok(!copy.includes('since last month'));assert.ok(copy.includes('Winner payout'));
  assert.equal(await card.locator('[data-active="true"]').count(),actual.submissionCount);
  assert.equal(await card.locator('select,button').count(),0); // All Time is a label, not a fake dropdown.
  const link=card.getByRole('link',{name:'Detail: '+actual.metadata.title});assert.equal(await link.count(),1);assert.ok((await link.getAttribute('href')).endsWith('/1'));
  await card.scrollIntoViewIfNeeded();await card.screenshot({path:out+'/card-'+width+'.png',animations:'disabled'});
  const measure=await card.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundImage,overflow:el.scrollWidth>el.clientWidth,docOverflow:document.documentElement.scrollWidth>innerWidth}));assert.equal(measure.overflow,false);assert.equal(measure.docOverflow,false);
  await link.focus();assert.equal(await link.evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Enter');
  await page.locator('dialog[open] .task-detail-title').waitFor({timeout:60000});await page.waitForFunction(t=>document.querySelector('dialog[open] .task-detail-title')?.textContent===t,actual.metadata.title,{timeout:60000});assert.equal(await page.locator('dialog[open] .task-detail-title').innerText(),actual.metadata.title);
  await page.keyboard.press('Escape');await page.waitForURL(u=>u.hash==='#tasks',{timeout:15000});
  reports.push({case:'actual-task1',width,copy,measure,detailNavigation:true,pageerrors:errors,nonGetRequests:badRequests});assert.deepEqual(errors,[]);assert.deepEqual(badRequests,[]);
  await context.close();
 }
 for(const [name,patch]of [['zero',{submissionCount:0,phase:'Open'}],['single',{submissionCount:1}],['maximum',{submissionCount:64}],['unknown',{submissionCount:undefined,amountUnavailable:true}],['large-payout',{payout:'123456789012345678901234567890123456'}]]){
  const task={...actual,...patch},context=await browser.newContext({viewport:{width:320,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/marketplace**',route=>route.fulfill({json:{...data,tasks:[task]}}));await page.goto(base,{waitUntil:'domcontentloaded',timeout:120000});const card=page.locator('[data-task-stats-card]').first();await card.getByText('Worker',{exact:true}).waitFor();
  const text=await card.innerText();if(name==='unknown')assert.match(text,/Agent count unavailable/);if(name==='zero')assert.match(text,/Earnings/);
  assert.equal(await card.locator('[data-active="true"]').count(),patch.submissionCount??(name==='unknown'?0:actual.submissionCount));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await card.evaluate(el=>el.scrollWidth>el.clientWidth),false);assert.deepEqual(errors,[]);
  reports.push({case:name,width:320,text,pageerrors:errors});await card.screenshot({path:out+'/'+name+'.png',animations:'disabled'});await context.close();
 }
}finally{await browser.close();}
await fs.writeFile(out+'/results.json',JSON.stringify({base,taskSource:'Unmodified public Task1 read-only; edge cases isolated browser fixtures',cases:reports.length,passed:true,reports},null,2));console.log(JSON.stringify({passed:true,cases:reports.length,out}));
