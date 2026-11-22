// Read-only browser integration. 1000 records below are synthetic fixtures, never public participants or paid tasks.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/Dimas Sawaludin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const base=process.argv[2]||'http://127.0.0.1:3107';
const label=process.argv[3]||'candidate';
const deployment=JSON.parse(await fs.readFile('lib/marketplace-v2-deployment.json','utf8'));
const officeDeployment=JSON.parse(await fs.readFile('lib/deployment.json','utf8'));
const block=135100000;
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const employee=(n)=>({address:address(n),employeeNumber:n,agentId:'fixture'+n+'.ai',joined:true,rank:n%5,rankName:['New hire','Intern','Staff','Senior','Manager'][n%5],totalCorrect:1001-n,stageCorrect:0,internStreak:0,joinedAt:1});
const people=Array.from({length:1000},(_,i)=>employee(i+1));
const assignments=people.map((e,i)=>({id:'0x'+(i+1).toString(16).padStart(64,'0'),employee:e.address,employeeNumber:e.employeeNumber,agentId:e.agentId,rank:e.rank,status:i%5,day:20000,takenAt:1,submittedAt:1,reviewedAt:1,tokenId:'0',evidence:'Synthetic local fixture',feedback:''}));
const tasks=people.map((e,i)=>({id:String(i+1),requester:e.address,winner:address(0),phase:i%2?'Review':'Open',status:1,token:deployment.token,tokenInfo:{address:deployment.token,symbol:'USDC',decimals:18,supported:true},bounty:'1000000000000000000',payout:'900000000000000000',submissionCount:0,submissionDeadline:2000000000,metadata:{title:'Synthetic task '+(i+1),description:'Local test fixture only, never funded.',category:'Fixture'},readBlock:block}));
const report={label,base,synthetic:true,checks:[],requests:[],errors:[]};
const check=(name,pass)=>{report.checks.push({name,pass:!!pass});if(!pass)console.log(JSON.stringify({failed:name}));};
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'no-preference'});
  await context.route('**/api/**',async route=>{
    const u=new URL(route.request().url()),p=u.searchParams;
    if(route.request().method()!=='GET'){report.errors.push('Unexpected mutation');return route.abort();}
    const limit=Number(p.get('limit')||12),offset=Number(p.get('offset')||0);
    let body;
    if(u.pathname==='/api/office'){
      check('Office uses summary mode',p.get('summary')==='1');
      body={deployment:officeDeployment,reviewer:address(9999),blockNumber:block,day:20000,stats:{employees:1000,assignments:1000,approved:400,awards:200}};
    }else if(u.pathname==='/api/people'){
      const q=(p.get('q')||'').toLowerCase(),rank=p.get('rank')||'All';
      const matched=people.filter(e=>(rank==='All'||String(e.rank)===rank)&&(!q||e.agentId.includes(q)||e.address.includes(q)));
      body={employees:matched.slice(offset,offset+limit),offset,limit,total:matched.length,nextOffset:offset+limit<matched.length?offset+limit:null,readBlock:block};
      report.requests.push({kind:'people',offset,limit,block:p.get('block'),q,rank,count:body.employees.length});
    }else if(u.pathname==='/api/assignments'){
      const view=p.get('view')||'all';
      const matched=assignments.filter(a=>view==='all'||view==='pending'&&a.status===1||view==='mine'&&a.employee===p.get('address'));
      body={assignments:matched.slice(offset,offset+limit),offset,limit,total:matched.length,nextOffset:offset+limit<matched.length?offset+limit:null,readBlock:block};
      report.requests.push({kind:'review',offset,limit,block:p.get('block'),view,count:body.assignments.length});
    }else if(u.pathname==='/api/tasks'){body={tasks:[]};}
    else if(u.pathname==='/api/marketplace'){
      const q=(p.get('q')||'').toLowerCase(),phase=p.get('phase')||'All';
      const matched=tasks.filter(t=>(phase==='All'||t.phase===phase)&&(!q||t.metadata.title.toLowerCase().includes(q)));
      body={tasks:matched.slice(offset,offset+limit),totalTasks:1000,matchedTasks:matched.length,nextOffset:offset+limit<matched.length?offset+limit:null,readBlock:block,activeDeployment:deployment,token:{address:deployment.token,symbol:'USDC',decimals:18}};
      report.requests.push({kind:'tasks',offset,limit,block:p.get('block'),q,phase,count:body.tasks.length});
    }else if(u.pathname==='/api/marketplace/config'){body={...deployment,activeDeployment:deployment,token:{address:deployment.token,symbol:'USDC',decimals:18},capabilities:{newTasksEnabled:true},newTasksEnabled:true};}
    else if(u.pathname==='/api/marketplace/health'){body={status:'degraded',components:{}};}
    else return route.continue();
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base+'/playground#people',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelectorAll('.person-card').length===12);
  const peoplePager=page.getByRole('navigation',{name:'People pagination',exact:true});
  await peoplePager.getByRole('button',{name:'People: next page',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.employee-number')?.textContent.includes('013'));
  check('People replaces with12 records on page2',await page.locator('.person-card').count()===12);
  check('People page2 carries immutable ID013',await page.locator('.employee-number').first().innerText().then(s=>s.includes('013')));
  await peoplePager.getByRole('button',{name:'People: previous page',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.employee-number')?.textContent.includes('001'));
  check('People previous restores page1 without append',await page.locator('.person-card').count()===12);
  await page.locator('.people-search input').fill('fixture999.ai');
  await page.waitForFunction(()=>document.querySelectorAll('.person-card').length===1&&document.querySelector('.person-card h3')?.textContent==='fixture999.ai');
  check('People search is globalserver-filtered and resets page',await peoplePager.innerText().then(s=>s.includes('Page 1 of 1')));
  await page.locator('.people-search input').fill('');
  await page.locator('.people-rank select').selectOption('3');
  await page.waitForFunction(()=>document.querySelectorAll('.person-card').length===12&&[...document.querySelectorAll('.person-card .mint-tag')].every(e=>e.textContent==='Senior'));
  check('People rank filter stays12 and globally sorted',true);
  const reviewPager=page.getByRole('navigation',{name:'Review pagination',exact:true});
  await page.waitForFunction(()=>document.querySelectorAll('.work-list button.work-row').length===10);
  const firstWork=await page.locator('.work-list button.work-row').first().innerText();
  await reviewPager.getByRole('button',{name:'Review: next page',exact:true}).click();
  await page.waitForFunction(old=>document.querySelector('.work-list button.work-row')?.innerText!==old,firstWork);
  check('Review replaces rows, capped10',await page.locator('.work-list button.work-row').count()===10);
  await reviewPager.getByRole('button',{name:'Review: previous page',exact:true}).click();
  await page.waitForFunction(old=>document.querySelector('.work-list button.work-row')?.innerText===old,firstWork);
  check('Review previous restores snapshot',true);
  for(const width of[320,390,768,1280]){await page.setViewportSize({width,height:844});check('Office fixture RWD '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2));}
  await page.screenshot({path:'artifacts/pagination/'+label+'-synthetic-office.png'});
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'/#tasks',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelectorAll('.market-task-card').length===12);
  const taskPager=page.getByRole('navigation',{name:'Tasks pagination',exact:true});
  await taskPager.getByRole('button',{name:'Tasks: next page',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.market-task-card h3')?.textContent==='Synthetic task 13');
  check('Tasks page2 replaces, capped12',await page.locator('.market-task-card').count()===12);
  await taskPager.getByRole('button',{name:'Tasks: previous page',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.market-task-card h3')?.textContent==='Synthetic task 1');
  check('Tasks previous restores page1',true);
  await page.locator('.market-search input').fill('Synthetic task 999');
  await page.waitForFunction(()=>document.querySelectorAll('.market-task-card').length===1&&document.querySelector('.market-task-card h3')?.textContent==='Synthetic task 999');
  check('Tasks global search replaces/reset page1',await taskPager.innerText().then(s=>s.includes('Page 1 of 1')));
  for(const width of[320,390,768,1280]){await page.setViewportSize({width,height:844});check('Tasks fixture RWD '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2));}
  check('All page requests are bounded to12or10',report.requests.every(r=>r.limit===(r.kind==='review'?10:12)&&r.count<=r.limit));
  check('People next request pinned block',report.requests.some(r=>r.kind==='people'&&r.offset===12&&r.block===String(block)));
  check('Review next request pinned block',report.requests.some(r=>r.kind==='review'&&r.offset===10&&r.block===String(block)));
  check('Tasks next request pinned block',report.requests.some(r=>r.kind==='tasks'&&r.offset===12&&r.block===String(block)));
  await context.close();
} finally {await browser.close();}
report.pass=report.checks.every(c=>c.pass)&&!report.errors.length;
await fs.writeFile('artifacts/pagination/'+label+'-browser.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));if(!report.pass)process.exitCode=1;
