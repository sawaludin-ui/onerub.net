// Node.js/Playwright — synthetic browser-only metadata recovery, no real wallet or production writes.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { hash, canonical, issueChallenge } from '../lib/marketplace-core.mjs';
import * as http from '../lib/marketplace-http.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Dimas Sawaludin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const base = process.argv[2] || 'http://127.0.0.1:3107', label = process.argv[3] || 'candidate';
const baseline = JSON.parse(await fs.readFile('artifacts/metadata-recovery/live-before.json', 'utf8')).task.data;
process.env.MARKETPLACE_AUTH_SECRET = randomBytes(32).toString('hex');
process.env.MARKETPLACE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.UPSTASH_REDIS_REST_URL = 'https://local-browser-fixture.invalid'; process.env.UPSTASH_REDIS_REST_TOKEN = 'never-used-fixture';
const wallet = Wallet.createRandom();
const metadata = { title: 'Browser recovery synthetic task', description: 'Validate full original public metadata recovery without publishing anything to the public service.', rubric: 'Correct data, commitment verification and explicit authorization only.', category: 'testing' };
const task = { ...baseline.task, requester: wallet.address, criteriaHash: hash(metadata), metadata: null, metadataVerified: false, phase: 'Open', status: 1 };
const records = new Map(); let commitCount = 0, challengeCount = 0;
const storage = { async get(k) { return records.get(k) || null; }, async limit() {}, async put(k,v) { records.set(k,v); return true; }, async commitMetadata(id,record,auth) { if(records.has('nonce:'+auth.nonce))throw Error('Unexpected duplicate');records.set('metadata:'+id,record);records.set('nonce:'+auth.nonce,true);commitCount++;return true; } };
const report = { label, base, synthetic: true, checks: [], errors: [] };
function check(name, pass) { report.checks.push({name,pass:Boolean(pass)}); if(!pass)throw Error(name); }
const browser = await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.exposeFunction('signSyntheticMetadata', async value => { const {EIP712Domain,...types}=value.types;return wallet.signTypedData(value.domain,types,value.message); });
 await page.addInitScript(({address})=>{window.__syntheticWalletCalls=[];if(location.search.includes('external=1'))return;window.ethereum={request:async({method,params})=>{window.__syntheticWalletCalls.push(method);if(method==='eth_requestAccounts'||method==='eth_accounts')return[address];if(method==='eth_chainId')return'0x38';if(method==='eth_signTypedData_v4')return window.signSyntheticMetadata(JSON.parse(params[1]));throw Error('Transactions forbidden in test');}};},{address:wallet.address});
 await page.route('**/api/marketplace**',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='POST'){
   const request=new Request(req.url(),{method:'POST',headers:{'Content-Type':'application/json'},body:req.postData()});
   let response;
   if(u.pathname.endsWith('/auth/challenge')) { challengeCount++;response=await http.handle(()=>http.challenge(request,{storage,config:{authentication:true}})); }
   else if(u.pathname.endsWith('/metadata')) response=await http.handle(()=>http.privateAction(request,String(task.id),'metadata',{storage,readTask:async()=>task,eligible:async a=>a.toLowerCase()===wallet.address.toLowerCase(),config:{privateStorage:true}}));
   else { await route.abort();return; }
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
  }
  const stored=records.get('metadata:'+task.id),current={...task,...(stored?{metadata:stored.metadata,metadataVerified:true,metadataHash:hash(stored.metadata),metadataCanonical:canonical(stored.metadata)}:{})};
  let data;
  if(u.pathname==='/api/marketplace')data={...baseline,tasks:[current],totalTasks:1,matchedTasks:1,readBlock:135120000,nextOffset:null};
  else if(u.pathname.includes('/tasks/'))data={...baseline,task:current};
  else if(u.pathname.endsWith('/health'))data={status:'degraded',checks:{evaluator:{status:'unknown'},uploads:{status:'unknown'},delivery:{status:'unknown'}}};
  else data=baseline;
  await route.fulfill({json:data});
 });
 await page.route('**/*',async route=>{if(new URL(route.request().url()).pathname.startsWith('/api/marketplace'))return route.fallback();if(!['GET','HEAD'].includes(route.request().method()))return route.abort();return route.continue();});
 await page.goto(base+'/tasks/56/'+baseline.contract+'/'+task.id,{waitUntil:'networkidle'});
 const publisher=page.locator('.metadata-publisher');await publisher.waitFor();
 check('No wallet connection/signing on render',(await page.evaluate(()=>window.__syntheticWalletCalls)).length===0);
 check('Missing brief blocks worker handoff',await page.locator('button[aria-describedby=worker-brief-status]').isDisabled());
 const area=publisher.locator('textarea[data-field=metadata]');
 await area.fill(JSON.stringify({...metadata,title:'Tampered metadata title'}));await publisher.getByRole('button',{name:'Verify original JSON',exact:true}).click();
 await publisher.getByRole('alert').filter({hasText:'CRITERIA_HASH_MISMATCH'}).waitFor();check('Wrong original hash rejected before any challenge/sign',challengeCount===0&&(await page.evaluate(()=>window.__syntheticWalletCalls)).length===0);
 await area.fill(JSON.stringify(metadata));await publisher.getByRole('button',{name:'Verify original JSON',exact:true}).click();await publisher.getByText('MATCH — original metadata matches criteriaHash. Ready for explicit authorization.').waitFor();
 check('Canonical local hash matches original before wallet connection',challengeCount===0);
 await publisher.getByRole('button',{name:'Connect requester wallet',exact:true}).click();await publisher.getByText(/Requester connected on BNB Smart Chain/).waitFor();
 check('Separate connect button does not sign',(await page.evaluate(()=>window.__syntheticWalletCalls)).filter(m=>m==='eth_signTypedData_v4').length===0);
 await publisher.getByRole('button',{name:'Sign metadata & publish',exact:true}).click();
 await page.locator('.metadata-integrity').getByText('MATCH — displayed metadata matches criteriaHash.',{exact:true}).waitFor();
 check('Signed real handler publishes once and public readback independently matches',commitCount===1&&challengeCount===1&&hash(records.get('metadata:'+task.id).metadata)===task.criteriaHash);
 const calls=await page.evaluate(()=>window.__syntheticWalletCalls);check('One explicit signature; zero transaction/approval methods',calls.filter(m=>m==='eth_signTypedData_v4').length===1&&!calls.some(m=>m==='eth_sendTransaction'||m==='wallet_sendCalls'||m==='personal_sign'));
 check('Known requester gets self-task notice',(await page.locator('dialog').innerText()).includes('own task'));
 check('Known requester cannot enter worker handoff',await page.locator('button[aria-describedby=worker-brief-status]').isDisabled());
 check('Deadline includes full year and UTC',(await page.locator('dialog').innerText()).includes('2026')&&(await page.locator('dialog').innerText()).includes('UTC'));
 await page.getByRole('button',{name:'Requester: recover / republish metadata',exact:true}).click();await publisher.waitFor();
 for(const width of[320,390,768,1280]){await page.setViewportSize({width,height:844});check('Recovery form fits width'+width,await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2));}
 await page.setViewportSize({width:390,height:844});await publisher.scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/metadata-recovery/'+label+'-recovery.png'});
 await page.getByRole('button',{name:/Close/}).first().click();
 const card=page.locator('.market-task-card').first();await card.waitFor();check('Board refresh replaces missing brief with actual title',(await card.innerText()).includes(metadata.title)&&!(await card.innerText()).includes('Brief not published'));
 task.policy={...task.policy,minScore:99};await page.goto(base+'/tasks/56/'+baseline.contract+'/'+task.id,{waitUntil:'networkidle'});
 await page.locator('.metadata-integrity').getByText('MISMATCH — policy JSON does not match policyHash.',{exact:false}).waitFor();
 check('Client policy mismatch blocks worker even when server policyVerified=true',await page.locator('button[aria-describedby=worker-brief-status]').isDisabled());
 task.policy=baseline.task.policy;task.id='2';records.clear();
 await page.goto(base+'/tasks/56/'+baseline.contract+'/2?external=1',{waitUntil:'networkidle'});await publisher.waitFor();
 await publisher.locator('input[type=file]').setInputFiles({name:'original.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(metadata))});
 await publisher.getByText('No injected wallet? Binance Agentic Wallet / external signer',{exact:true}).click();
 await publisher.locator('[data-field=manual-address]').fill(wallet.address);await publisher.getByRole('button',{name:'Get metadata signing challenge',exact:true}).click();
 await publisher.locator('textarea[name=typedData]').waitFor();const typed=JSON.parse(await publisher.locator('textarea[name=typedData]').inputValue());const{EIP712Domain,...types}=typed.types;
 const manualSignature=await wallet.signTypedData(typed.domain,types,typed.message);await publisher.locator('[data-field=signature]').fill(manualSignature);await publisher.getByRole('button',{name:'Verify signature & publish',exact:true}).click();
 await page.locator('.metadata-integrity').getByText('MATCH — displayed metadata matches criteriaHash.',{exact:true}).waitFor();
 check('External wallet signature plus original file recovers metadata without injected provider',commitCount===2&&challengeCount===2&&(await page.evaluate(()=>window.__syntheticWalletCalls)).length===0);
 check('No runtime JS errors',report.errors.length===0);
 report.walletMethods=calls;report.commitCount=commitCount;report.challengeCount=challengeCount;report.pass=true;
} catch(e){report.pass=false;report.error=e.message;process.exitCode=1;} finally {await browser.close();await fs.writeFile('artifacts/metadata-recovery/'+label+'-browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
