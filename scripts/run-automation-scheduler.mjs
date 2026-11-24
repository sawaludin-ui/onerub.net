// GitHub Actions/Node.js — bounded authenticated scheduler; never signs wallet requests locally.
import {pathToFileURL}from'node:url';import path from'node:path';
export async function runScheduler({secret=process.env.ONERUB_AUTOMATION_SECRET,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),durationMs=220000,maxTicks=24,base='https://onerub.net'}={}){
 if(typeof secret!=='string'||secret.length<32)throw Error('SCHEDULER_SECRET_REQUIRED');
 if(base!=='https://onerub.net')throw Error('SCHEDULER_ORIGIN_INVALID');
 const end=now()+durationMs;let ticks=0,last;
 while(now()<end&&ticks<maxTicks){
  const start=now();try{const res=await fetcher(base+'/api/marketplace/automation',{method:'POST',headers:{authorization:'Bearer '+secret,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(65000)});const data=await res.json();
   if([401,403].includes(res.status))throw Error('SCHEDULER_AUTH_FAILED');
   ticks++;last={httpStatus:res.status,status:data.status,discovered:data.discovered,claimed:data.claimed,completed:data.completed,deferred:data.deferred,missed:data.missed,alerts:data.alerts,queue:data.queue?{pending:data.queue.pending,ready:data.queue.ready,delayed:data.queue.delayed,budgetUsed:data.queue.budgetUsed}:undefined,capacity:data.capacity};
   console.log(JSON.stringify(last));if(data.enabled===false)throw Error('AUTOMATION_DISABLED');
   if(res.ok&&data.claimed===0&&(data.queue?.pending||0)===0)break;
   if(res.ok&&data.claimed===0&&data.queue?.ready===0&&data.queue?.running===0)break; // Waiting for future deadlines; next schedule discovers again.
  }catch(e){if(['SCHEDULER_AUTH_FAILED','AUTOMATION_DISABLED'].includes(e.message))throw e;console.log(JSON.stringify({code:'SCHEDULER_TICK_RETRY'}));ticks++;}
  const delay=Math.max(1000,8000-(now()-start));if(now()+delay>=end)break;await sleep(delay);
 }
 return{ticks,last};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{await runScheduler();}catch(e){console.error(JSON.stringify({code:/^[A-Z_]+$/.test(e.message)?e.message:'SCHEDULER_FAILED'}));process.exitCode=1;}}
