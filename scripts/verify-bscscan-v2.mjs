// Node.js — BscScan public source-verification browser; no wallet, transactions, or secret access.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const manifest=JSON.parse(await fs.readFile(new URL('../lib/marketplace-v2-deployment.json',import.meta.url),'utf8'));
const inputPath=new URL('../artifacts/marketplace-v2/deployed-compiler-input.json',import.meta.url);
const input=await fs.readFile(inputPath,'utf8');
const compiler=manifest.compiler.replace(/\.Emscripten\.clang$/,'');
const out=new URL('../artifacts/remediation-bscscan/',import.meta.url);await fs.mkdir(out,{recursive:true});
const evidence={address:manifest.address,chainId:manifest.chainId,compiler,inputSha256:createHash('sha256').update(input).digest('hex'),sourceOnly:true,network:[],steps:[]};
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),args:['--no-first-run','--disable-background-networking']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Jakarta'});const page=await context.newPage();
 page.on('response',r=>{if(r.url().includes('bscscan.com')&&(r.request().isNavigationRequest()||/verify/i.test(r.url())))evidence.network.push({url:r.url(),status:r.status(),method:r.request().method()});});
 const response=await page.goto('https://bscscan.com/verifyContract?a='+manifest.address,{waitUntil:'domcontentloaded',timeout:60000});
 evidence.initialStatus=response?.status();
 evidence.steps.push({url:page.url(),title:await page.title(),body:(await page.locator('body').innerText()).slice(-18000),controls:await page.locator('select').evaluateAll(es=>es.map(e=>({id:e.id,name:e.name,options:[...e.options].map(o=>({value:o.value,text:o.textContent}))})))});
 if(process.argv.includes('--continue')&&await page.locator('#ContentPlaceHolder1_ddlCompilerType').count()){
  await page.locator('#ContentPlaceHolder1_ddlCompilerType').selectOption({label:'Solidity (Standard-Json-Input)'});
  await page.locator('#ContentPlaceHolder1_ddlCompilerVersions').selectOption({label:'v'+compiler});
  await page.locator('#ContentPlaceHolder1_ddlLicenseType').selectOption({label:'3) MIT License (MIT)'});
  await page.locator('#chkTermsOfUse').check();
  await Promise.all([page.waitForLoadState('domcontentloaded'),page.locator('#ContentPlaceHolder1_btnSubmit').click()]);
  await page.waitForLoadState('domcontentloaded');
  evidence.steps.push({url:page.url(),title:await page.title(),body:(await page.locator('body').innerText()).slice(-18000),controls:await page.locator('input,select,textarea,button').evaluateAll(es=>es.filter(e=>!['hidden','password'].includes(e.type)).map(e=>({tag:e.tagName,id:e.id,name:e.name,type:e.type,text:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:o.textContent})):e.textContent?.slice(0,100)})))});
 }
 await page.screenshot({path:fileURLToPath(new URL('verification-form.png',out)),fullPage:true});
} catch(error){evidence.error=error.message;}finally{await browser.close();await fs.writeFile(new URL('evidence.json',out),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
