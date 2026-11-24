// Node / Playwright: isolated local fixtures plus read-only public Task #1; no wallet/provider writes.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Dimas Sawaludin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const base = process.env.AUDIT_UI_BASE || 'http://127.0.0.1:3017';
const out = 'artifacts/audit-final-ui';
const escrow = '0x0D33DD09131aC17827fA165D70daAAB4DBfC299a';
await mkdir(out,{recursive:true});
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const results=[];
try {
  const response = await fetch('https://onerub.net/api/marketplace?limit=12',{signal:AbortSignal.timeout(45000)});
  assert.equal(response.status,200); const market=await response.json();
  const detailResponse=await fetch('https://onerub.net/api/marketplace/tasks/1?chainId=56&escrowAddress='+escrow,{signal:AbortSignal.timeout(45000)});
  assert.equal(detailResponse.status,200); const detail=await detailResponse.json();
  for(const width of [320,390,768,1440]) {
    for(const mode of ['slow','offline','disabled']) {
      const context=await browser.newContext({viewport:{width,height:960}}); const page=await context.newPage(); const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      let release; const gate=new Promise(resolve=>{release=resolve;});
      await page.route('**/api/marketplace**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/marketplace') {
          if(mode==='slow') await gate;
          if(mode==='offline') return route.abort('internetdisconnected');
          return route.fulfill({json:{...market,newTasksEnabled:mode!=='disabled'}});
        }
        return route.fulfill({json:{status:'unknown'}});
      });
      try {
        const response=await page.goto(base,{waitUntil:'domcontentloaded',timeout:120000}); assert.equal(response.status(),200);
        const note=page.locator('#funding-upgrade-note');
        if(mode==='slow') {
          await note.waitFor(); assert.match(await note.innerText(),/Checking marketplace readiness/);
          assert.doesNotMatch(await note.innerText(),/paused/);
          await page.screenshot({path:out+'/fixture-slow-'+width+'.png'});
          release(); await page.getByRole('button',{name:'Post & fund a task',exact:true}).waitFor();
          await page.waitForFunction(()=>!document.querySelector('.hero-actions button').disabled);
        } else {
          await page.waitForFunction(expected=>document.querySelector('#funding-upgrade-note')?.dataset.fundingStatus===expected,mode==='offline'?'unavailable':'disabled');
          assert.match(await note.innerText(), mode==='offline'?/status unavailable/:/paused/);
          await page.screenshot({path:out+'/fixture-'+mode+'-'+width+'.png'});
        }
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth); assert.equal(overflow,false);
        assert.deepEqual(errors,[]); results.push({type:'fixture',mode,width,overflow,pageerrors:errors,passed:true});
      } finally { release(); await context.close(); }
    }
    const context=await browser.newContext({viewport:{width,height:960}}); const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/marketplace**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/marketplace/tasks/1') return route.fulfill({json:detail});
      if(url.pathname==='/api/marketplace') return route.fulfill({json:market});
      return route.fulfill({json:{status:'unknown'}});
    });
    try {
      const response=await page.goto(base+'/tasks/56/'+escrow+'/1',{waitUntil:'domcontentloaded',timeout:120000});assert.equal(response.status(),200);
      await page.locator('dialog[open]').waitFor({timeout:60000});
      await page.getByText('Immutable tie-break',{exact:true}).waitFor();
      const text=await page.locator('dialog[open]').innerText(); assert.match(text,/lowest wallet address/); assert.match(text,/onerub-review-v2/);
      await page.screenshot({path:out+'/actual-public-task1-'+width+'.png'});
      await page.getByText('Legacy rule:',{exact:false}).scrollIntoViewIfNeeded();
      await page.screenshot({path:out+'/actual-task1-judge-'+width+'.png'});
      await page.getByText('Task timeline · payment ≠ delivery',{exact:true}).scrollIntoViewIfNeeded();
      assert.match(await page.locator('dialog[open]').innerText(),/Settled on-chain — inspect the settlement receipt/);
      await page.screenshot({path:out+'/actual-task1-timeline-'+width+'.png'});
      await page.waitForFunction(()=>document.title.includes('Teka-Teki'),{},{timeout:60000});
      const seo=await page.evaluate(()=>({title:document.title,description:document.querySelector('meta[name="description"]')?.content,og:document.querySelector('meta[property="og:title"]')?.content,overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth}));
      assert.equal(seo.overflow,false);assert.equal(seo.dialogOverflow,false);assert.deepEqual(errors,[]);
      await page.keyboard.press("Escape");
      await page.waitForURL(url => url.hash === "#tasks", {timeout:15000});
      results.push({type:'actual-public-task1',note:'Public API response reused unchanged client-side; server metadata reads chain and hash-verified stored public metadata',width,status:response.status(),...seo,pageerrors:errors,passed:true});
    } finally {await context.close();}
  }
} finally {
  await browser.close(); await writeFile(out+'/results.json',JSON.stringify(results,null,2));
}
console.log(JSON.stringify(results,null,2));
