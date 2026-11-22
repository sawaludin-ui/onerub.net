// Isolated loopback HTTP integration: real server MAC/EIP-712 verification, synthetic chain/storage only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { RedisStore, MarketplaceError, deployment, hash, canonical, storePrefix } from '../lib/marketplace-core.mjs';
import { handle, challenge, privateAction, publicTask, prepare, fundingPreflight } from '../lib/marketplace-http.mjs';
import { ACTION_CONTRACT, METADATA_FIELDS, METADATA_EXAMPLE, metadataPayload } from '../lib/marketplace-action-contract.mjs';
process.env.MARKETPLACE_AUTH_SECRET = randomBytes(32).toString('hex');
process.env.MARKETPLACE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const config = { privateStorage: true, authentication: true, evaluator: true };
// Capabilities checks in enrichTask use configuration only. No call reaches these dummy URLs.
process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1';
process.env.UPSTASH_REDIS_REST_TOKEN = 'isolated-test-only';
class MemoryStore extends RedisStore {
  values = new Map(); writes = 0; failCommit = false; loseResponse = false;
  async limit() {}
  async get(k) { return structuredClone(this.values.get(k) ?? null); }
  async put(k,v,{nx=false}={}) { if(nx && this.values.has(k)) return false; this.values.set(k,structuredClone(v)); return true; }
  async command(op,script,n,nonceKey,metadataKey,record,ttl) {
    assert.equal(op,'EVAL'); assert.equal(n,'2'); assert.equal(ttl,'600');
    assert.match(script,/EXISTS/); assert.match(script,/SET/);
    if(this.failCommit) { this.failCommit=false; throw new MarketplaceError('Storage unavailable.',503,'STORAGE_UNAVAILABLE'); }
    const nk=nonceKey.slice(storePrefix.length), mk=metadataKey.slice(storePrefix.length);
    if(this.values.has(nk)) return -1;
    if(this.values.has(mk) && JSON.stringify(this.values.get(mk))!==record) return -2;
    if(!this.values.has(mk)) {this.values.set(mk,JSON.parse(record));this.writes++;}
    this.values.set(nk,true);
    if(this.loseResponse) {this.loseResponse=false;throw new MarketplaceError('Storage unavailable.',503,'STORAGE_UNAVAILABLE');}
    return 1;
  }
}
const health = () => ({status:'degraded',checks:Object.fromEntries(['rpc','storage','encryption','attestation','evaluator','uploads','delivery'].map(k=>[k,{status:['evaluator','uploads','delivery'].includes(k)?'unknown':'available'}]))});
async function fixture(fn) {
  const wallet=Wallet.createRandom(), storage=new MemoryStore();
  let task={id:'1',requester:wallet.address,bounty:'1000000000000000000',criteriaHash:hash(METADATA_EXAMPLE),status:1,phase:'Open'};
  let eligible=true, readError=false, currentHealth=health();
  const deps={storage,config,readTask:async()=>{if(readError){readError=false;throw Error('private RPC diagnostic');}return task;},eligible:async()=>eligible};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
    const response=await handle(()=>req.url==='/challenge'?challenge(request,deps):req.url==='/prepare'?prepare(request,{...deps,readHealth:async()=>currentHealth}):req.method==='GET'?publicTask('1',request,{...deps,observe:async()=>({})}):privateAction(request,'1','metadata',deps));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
  const authorize=async(payload,w=wallet,domainPatch={})=>{
    const c=await post('/challenge',{address:w.address,action:'metadata',taskId:'1',payloadHash:hash(payload)});assert.equal(c.status,200);
    const {typedData,status,...auth}=c;
    auth.signature=await w.signTypedData({...typedData.domain,...domainPatch},{Authorization:typedData.types.Authorization},typedData.message);
    return {chainId:deployment.chainId,escrowAddress:deployment.address,auth,payload};
  };
  try {await fn({wallet,storage,post,authorize,get:async()=>{const r=await fetch(base+'/task');return {status:r.status,...await r.json()};},setTask:v=>task={...task,...v},setEligible:v=>eligible=v,setReadError:()=>readError=true,setHealth:v=>currentHealth=v});}
  finally{server.close();server.closeAllConnections();await once(server,'close');}
}
test('canonical documented example passes real HTTP challenge/sign/publish/readback',async()=>fixture(async f=>{
  const payload=structuredClone(ACTION_CONTRACT.metadata.payload),body=await f.authorize(payload);
  assert.equal((await f.post('/metadata',body)).registered,true);
  const read=await f.get();assert.equal(read.status,200);assert.deepEqual(read.task.metadata,METADATA_EXAMPLE);
  assert.equal(read.task.metadataVerified,true);assert.equal(read.task.metadataCanonical,canonical(METADATA_EXAMPLE));assert.equal(read.task.metadataHash,hash(METADATA_EXAMPLE));
  assert.equal((await f.post('/metadata',body)).code,'REPLAY');assert.equal(f.storage.writes,1);
}));
test('legacy flat payload uses its raw signed hash; unsigned top-level fallback never accepted',async()=>fixture(async f=>{
  const body=await f.authorize({...METADATA_EXAMPLE});body.metadata={...METADATA_EXAMPLE,title:'UNSIGNED ALTERATION'};
  assert.equal((await f.post('/metadata',body)).status,200);assert.deepEqual((await f.get()).task.metadata,METADATA_EXAMPLE);
  const empty=await f.authorize({});empty.metadata=METADATA_EXAMPLE;
  const r=await f.post('/metadata',empty);assert.equal(r.status,400);assert.equal(r.code,'METADATA_FIELD_INVALID');assert.equal(r.field,'payload.metadata.title');assert.equal(f.storage.values.has('nonce:'+empty.auth.nonce),false);
}));
test('400 field validation leaves nonce unspent; payload correction under old signature is rejected',async()=>fixture(async f=>{
  const body=await f.authorize(metadataPayload({...METADATA_EXAMPLE,title:'x'}));
  const a=await f.post('/metadata',body);assert.equal(a.status,400);assert.equal(a.code,'METADATA_FIELD_INVALID');assert.equal(a.field,'payload.metadata.title');assert.equal(a.received,'string length 1');
  assert.equal((await f.post('/metadata',body)).status,400);
  assert.equal((await f.post('/metadata',{...body,payload:metadataPayload(METADATA_EXAMPLE)})).status,401);
  assert.equal(f.storage.values.has('nonce:'+body.auth.nonce),false);assert.equal(f.storage.writes,0);
  assert.equal((await f.post('/metadata',await f.authorize(metadataPayload(METADATA_EXAMPLE)))).status,200);
}));
test('every metadata field boundary and malformed envelope gives an allowlisted field error without nonce consumption',async()=>fixture(async f=>{
  for(const [key,min,max] of METADATA_FIELDS) {
    for(const value of [null,7,{},'x'.repeat(min-1),'x'.repeat(max+1)]) {
      const body=await f.authorize(metadataPayload({...METADATA_EXAMPLE,[key]:value}));
      const r=await f.post('/metadata',body);assert.equal(r.status,400);assert.equal(r.code,'METADATA_FIELD_INVALID');assert.equal(r.field,'payload.metadata.'+key);
      assert.equal(f.storage.values.has('nonce:'+body.auth.nonce),false);
    }
  }
  for(const metadata of [null,[],false]) {
    const body=await f.authorize({metadata});const r=await f.post('/metadata',body);assert.equal(r.code,'METADATA_REQUIRED');assert.equal(r.field,'payload.metadata');
  }
  const body=await f.authorize({});delete body.payload;body.metadata=METADATA_EXAMPLE;
  const r=await f.post('/metadata',body);assert.equal(r.code,'METADATA_PAYLOAD_REQUIRED');assert.equal(r.field,'payload');assert.equal(f.storage.writes,0);
}));
test('invalid unsigned envelope can be corrected without changing signed raw payload or signature',async()=>fixture(async f=>{
  const body=await f.authorize(metadataPayload(METADATA_EXAMPLE));
  assert.equal((await f.post('/metadata',{...body,chainId:999})).code,'DEPLOYMENT_MISMATCH');
  assert.equal(f.storage.values.has('nonce:'+body.auth.nonce),false);
  assert.equal((await f.post('/metadata',body)).status,200);
}));
test('eight concurrent exact signed requests mutate metadata once and replay409',async()=>fixture(async f=>{
  const body=await f.authorize(metadataPayload(METADATA_EXAMPLE));
  const all=await Promise.all(Array.from({length:8},()=>f.post('/metadata',body)));
  assert.equal(all.filter(r=>r.status===200).length,1);assert.equal(all.filter(r=>r.code==='REPLAY').length,7);assert.equal(f.storage.writes,1);
}));
test('RPC503 and failed atomic command recover on identical signature; lost commit reply replay is safe',async()=>fixture(async f=>{
  const body=await f.authorize(metadataPayload(METADATA_EXAMPLE));f.setReadError();
  const a=await f.post('/metadata',body);assert.equal(a.status,503);assert.equal(a.retryable,true);assert.doesNotMatch(JSON.stringify(a),/private RPC/);
  f.storage.failCommit=true;assert.equal((await f.post('/metadata',body)).status,503);assert.equal(f.storage.values.has('nonce:'+body.auth.nonce),false);
  f.storage.loseResponse=true;assert.equal((await f.post('/metadata',body)).status,503);
  assert.equal((await f.post('/metadata',body)).code,'REPLAY');assert.equal((await f.get()).task.metadataVerified,true);assert.equal(f.storage.writes,1);
}));
test('owner, membership, state, criteria, domain, expiry, and signature remain enforced without nonce burn',async()=>fixture(async f=>{
  const payload=metadataPayload(METADATA_EXAMPLE),body=await f.authorize(payload);
  f.setEligible(false);assert.equal((await f.post('/metadata',body)).code,'AGENT_ID_REQUIRED');f.setEligible(true);
  f.setTask({requester:Wallet.createRandom().address});assert.equal((await f.post('/metadata',body)).code,'FORBIDDEN');f.setTask({requester:f.wallet.address});
  f.setTask({status:3});assert.equal((await f.post('/metadata',body)).status,409);f.setTask({status:1});
  f.setTask({criteriaHash:hash({different:true})});assert.equal((await f.post('/metadata',body)).code,'COMMITMENT_MISMATCH');f.setTask({criteriaHash:hash(METADATA_EXAMPLE)});
  assert.equal((await f.post('/metadata',await f.authorize(payload,f.wallet,{chainId:999}))).code,'INVALID_SIGNATURE');
  assert.equal((await f.post('/metadata',await f.authorize(payload,f.wallet,{verifyingContract:Wallet.createRandom().address}))).code,'INVALID_SIGNATURE');
  assert.equal((await f.post('/metadata',{...body,auth:{...body.auth,challenge:'0'.repeat(64)}})).code,'INVALID_AUTH');
  assert.equal((await f.post('/metadata',{...body,auth:{...body.auth,expiresAt:1}})).code,'INVALID_AUTH');
  assert.equal((await f.post('/metadata',{...body,auth:{...body.auth,signature:'0x00'}})).code,'INVALID_AUTH');
  assert.equal(f.storage.values.has('nonce:'+body.auth.nonce),false);assert.equal((await f.post('/metadata',body)).status,200);
  assert.equal((await f.post('/metadata',await f.authorize(payload))).status,200);assert.equal(f.storage.writes,1);
}));
test('funding HTTP warns for exact unknown components; explicit acknowledgement is request and state bound',async()=>fixture(async f=>{
  const p={action:'approve',amount:'1',chainId:deployment.chainId,escrowAddress:deployment.address};
  const r=await f.post('/prepare',p);assert.equal(r.status,409);assert.equal(r.code,'HEALTH_ACK_REQUIRED');
  assert.equal(r.readiness.checks.evaluator.status,'unknown');assert.equal(r.readiness.checks.uploads.status,'unknown');assert.equal(r.readiness.checks.delivery.status,'unknown');
  const ack={...r.healthAcknowledgement,accepted:true};
  const ok=await f.post('/prepare',{...p,healthAcknowledgement:ack});assert.equal(ok.status,200);assert.equal(ok.fundingReadiness.status,'degraded');assert.equal(ok.fundingReadiness.acknowledged,true);
  assert.equal((await f.post('/prepare',{...p,amount:'2',healthAcknowledgement:ack})).code,'HEALTH_ACK_REQUIRED');
  const h=health();h.status='healthy';f.setHealth(h);assert.equal((await f.post('/prepare',p)).code,'HEALTH_ACK_REQUIRED');h.status='degraded';h.checks.evaluator={status:'cooldown',retryAt:123};f.setHealth(h);
  assert.equal((await f.post('/prepare',{...p,healthAcknowledgement:ack})).code,'HEALTH_ACK_REQUIRED');
  h.checks.storage={status:'unavailable'};f.setHealth(h);assert.equal((await f.post('/prepare',{...p,healthAcknowledgement:ack})).code,'FUNDING_UNAVAILABLE');
}));
test('funding acknowledgement expiry, opt-in and fatal configuration cannot be bypassed',async()=>{
  const p={action:'createAndFund',amount:'1',metadata:METADATA_EXAMPLE};
  let warning;try{await fundingPreflight(p,{readHealth:async()=>health(),config,now:100});}catch(e){warning=e;}
  assert.equal(warning.code,'HEALTH_ACK_REQUIRED');const ack={...warning.healthAcknowledgement,accepted:true};
  for(const value of [{...ack,accepted:false},{...ack,expiresAt:99},{...ack,token:'0'.repeat(64)}])
    await assert.rejects(fundingPreflight({...p,healthAcknowledgement:value},{readHealth:async()=>health(),config,now:100}),e=>e.code==='HEALTH_ACK_REQUIRED');
  for(const key of ['privateStorage','authentication','evaluator'])
    await assert.rejects(fundingPreflight({...p,healthAcknowledgement:ack},{readHealth:async()=>health(),config:{...config,[key]:false},now:100}),e=>e.code==='FUNDING_UNAVAILABLE');
});
