import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { taskStatsView } from '../app/components/task-stats-view.mjs';
const chainId=56, contract='0x0D33DD09131aC17827fA165D70daAAB4DBfC299a';
const token={address:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',symbol:'USDC',decimals:18,supported:true};
const task={id:'1',phase:'Settled',token:token.address,requester:'0x607cF25614065179a9238705E03E6590C082F56d',payout:'900000000000000000',submissionCount:14,metadata:{title:'Private report never rendered in the card'}};
const view=t=>taskStatsView(t,{fallbackToken:token,chainId,contract});
test('actual settled card keeps bounty units, one project/requester and distinct committed workers',()=>{
 const v=view(task);assert.equal(v.value,'0.9');assert.equal(v.symbol,'USDC');assert.equal(v.projects,1);assert.equal(v.clients,1);assert.equal(v.agents,14);assert.equal(v.number,'001');assert.equal(v.note,'Paid on-chain');assert.equal(v.barCount,30);
 assert.equal(v.href,'/tasks/56/'+contract.toLowerCase()+'/1');
});
test('unpaid phases never claim future bounty was earned',()=>{
 for(const phase of ['Open','Review','Expired','Refunded','Cancelled']){const v=view({...task,phase});assert.equal(v.value,'0');assert.equal(v.paid,false);assert.equal(v.note,'Not paid yet');}
});
test('unknown amounts, unsupported tokens and counts never fabricate a metric',()=>{
 assert.equal(view({...task,amountUnavailable:true}).value,'—');assert.equal(view({...task,token:'0x'+'ab'.repeat(20)}).value,'—');
 for(const submissionCount of [undefined,null,"",-1,1.5,'garbage',Infinity]){const v=view({...task,submissionCount});assert.equal(v.knownAgents,false);assert.equal(v.agents,0);}
 assert.equal(view({...task,requester:undefined}).clients,null);assert.equal(view({...task,requester:'0x'+'0'.repeat(40)}).clients,null);
});
test('agent chart is bounded and shows exact text for zero, one, and maximum entrants',()=>{
 for(const n of [0,1,14,30,64]){const v=view({...task,submissionCount:n});assert.equal(v.agents,n);assert.equal(v.barCount,Math.max(30,n));}
 assert.equal(view({...task,submissionCount:10000}).barCount,64);
});
test('change is a standalone presentation with native Detail link and no new side effects',()=>{
 const component=fs.readFileSync(new URL('../app/components/TaskStatsCard.js',import.meta.url),'utf8');
 const css=fs.readFileSync(new URL('../app/components/TaskStatsCard.module.css',import.meta.url),'utf8');
 assert.match(component,/<article/);assert.match(component,/<a className={styles.detail} href={view.href}/);assert.match(component,/All Time/);assert.match(component,/aria-label={view.knownAgents/);
 assert.doesNotMatch(component,/fetch[(]|useEffect|setInterval|Math[.]random|signTransaction|since last month|5 this month|3 this month/);
 assert.doesNotMatch(component,/TASK [/]|Winner payout|Gross |submissions<|market-task-title|market-task-description|task[.]metadata/);
 assert.match(css,/container-type: inline-size/);assert.match(css,/.detail:focus-visible/);assert.doesNotMatch(css,/@keyframes|animation:/);
});
