import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { taskStatsView } from '../app/components/task-stats-view.mjs';
import { buildAvailabilitySegments, getSpectrumColor, extractTaskDigits, formatAgentCountLabel } from '../app/components/provided-task-stats.mjs';
const chainId=56,contract='0x0D33DD09131aC17827fA165D70daAAB4DBfC299a';
const token={address:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',symbol:'USDC',decimals:18,supported:true};
const task={id:'1',phase:'Settled',token:token.address,payout:'900000000000000000',submissionCount:14,submissionDeadline:1795528800,metadata:{title:'Teka-Teki 7 Rumah',description:'Public brief'}};
const view=t=>taskStatsView(t,{fallbackToken:token,chainId,contract});
test('ZIP adapter uses live payout, count and WIB deadline without demo identities',()=>{
 const v=view(task);assert.equal(v.payoutAmount,'0.9');assert.equal(v.payoutCurrency,'USDC');assert.equal(v.submissionsCount,14);assert.equal(v.agentsEntered,14);assert.equal(v.taskNumber,'01');assert.equal(v.dueDatePrimary,'24 Nov');assert.equal(v.dueYear,'2026');assert.equal(v.dueTimeLabel,'21:00 WIB');assert.deepEqual(v.agents,[]);assert.equal(v.href,'/tasks/56/'+contract.toLowerCase()+'/1');assert.equal(v.payoutHighlight,'Winner payout');assert.equal(v.totalAgentSlots,30);
});
test('unknown count, amount and deadline stay unknown',()=>{
 assert.equal(view({...task,amountUnavailable:true}).payoutAmount,'—');assert.equal(view({...task,token:'0x'+'ab'.repeat(20)}).payoutAmount,'—');
 for(const submissionCount of [undefined,null,'',-1,1.5,'invalid',Infinity]){const v=view({...task,submissionCount});assert.equal(v.knownAgents,false);assert.equal(v.agentsEntered,0);assert.equal(v.submissionsCount,'—');}
 for(const submissionDeadline of [undefined,null,0,NaN,Infinity,'invalid'])assert.equal(view({...task,submissionDeadline}).dueTimeLabel,'Unavailable');
});
test('ZIP original color interpolation endpoints and inactive color are unchanged',()=>{
 assert.equal(getSpectrumColor(0,14),'rgb(10, 132, 255)');assert.equal(getSpectrumColor(13,14),'rgb(244, 114, 92)');assert.equal(getSpectrumColor(0,1),'rgb(10, 132, 255)');const s=buildAvailabilitySegments(14,30);assert.equal(s.length,30);assert.equal(s.filter(x=>x.isActive).length,14);assert.equal(s[14].color,'#38383A');
});
test('ZIP bars handle zero, one, maximum and missing inputs',()=>{
 for(const n of [0,1,14,30,64]){const v=view({...task,submissionCount:n}),s=buildAvailabilitySegments(v.agentsEntered,v.totalAgentSlots);assert.equal(s.filter(x=>x.isActive).length,n);assert.ok(s.length<=64);}
 assert.equal(buildAvailabilitySegments(NaN,NaN).length,30);assert.equal(buildAvailabilitySegments(10000,10000).length,64);assert.equal(formatAgentCountLabel(1),'1 agent');assert.equal(formatAgentCountLabel(14),'14 agents');assert.equal(extractTaskDigits('TASK / 001'),'001');
});
test('ZIP component preserves 3D, speckles, typography and native Detail',()=>{
 const component=fs.readFileSync(new URL('../app/components/TaskStatsCard.js',import.meta.url),'utf8');const css=fs.readFileSync(new URL('../app/components/TaskStatsCard.module.css',import.meta.url),'utf8');
 for(const value of ['<article','href={detailHref}','aria-label={"Detail: " + task.title}','perspective(1000px)','onPointerMove','viewBox="0 0 328 76"','Worker','max-w-[376px]','text-[48px]','text-[44px]','fillOpacity="0.14"'])assert.ok(component.includes(value),value);
 for(const value of ['fetch(','setInterval','Math.random','signTransaction','since last month','All Time','requester wallet'])assert.ok(!component.includes(value),value);
 for(const value of ['scope','TaskCardInter','prefers-reduced-motion',':global'])assert.ok(css.includes(value),value);
});
test('all original ZIP style classes and26speckles are preserved verbatim',()=>{
 const design=JSON.parse(fs.readFileSync(new URL('./fixtures/provided-task-card-design.json',import.meta.url),'utf8'));
 const component=fs.readFileSync(new URL('../app/components/TaskStatsCard.js',import.meta.url),'utf8');
 for(const className of design.classNames)assert.ok(component.includes(className),className);
 for(const shape of design.shapes)assert.ok(component.includes(shape),shape);
 assert.equal(design.shapes.length,26);
});
