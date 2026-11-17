// Own isolated Compose project: crash/restore tests never restart the daily service.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'
import { stringify } from 'yaml'
if (!process.argv.includes('--live')) throw new Error('Pass --live for isolated recovery tests and paid synthetic extraction')
const env = parseEnv(readFileSync('role-agent/deploy/hindsight/.env','utf8'))
const freePort = () => new Promise((done,reject) => { const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(p))}) })
const ports = await Promise.all([freePort(),freePort(),freePort()])
const root=resolve('.');mkdirSync('.tmp/m3',{recursive:true});const run=mkdtempSync(resolve('.tmp/m3/service-'))
const project='role-m3-'+randomUUID().slice(0,8),bank=project+'-recovery',loadBank=project+'-load'
const childEnv={...process.env,...env,HINDSIGHT_API_PORT:String(ports[0]),HINDSIGHT_UI_PORT:String(ports[1]),HINDSIGHT_DB_PORT:String(ports[2])}
const base=resolve('role-agent/deploy/hindsight'),overlay=join(run,'isolation.yaml'),restore=join(run,'restore.yaml')
writeFileSync(overlay,stringify({volumes:{models:{external:true,name:'role-agent-memory_models'}}}))
writeFileSync(restore,stringify({services:{hindsight:{environment:{HINDSIGHT_API_DATABASE_URL:'postgresql://hindsight:${HINDSIGHT_DB_PASSWORD}@127.0.0.1:${HINDSIGHT_DB_PORT}/hindsight_restored'}}}}))
const args=['compose','--progress','quiet','--env-file',join(base,'.env'),'-p',project,'-f',join(base,'compose.yaml'),'-f',join(base,'compose.host-network.yaml'),'-f',overlay]
let restoring=false
const command=(extra,{restoreDB=restoring}={})=>new Promise((done,reject)=>{
 const c=spawn('docker',[...args,...(restoreDB?['-f',restore]:[]),...extra],{env:childEnv,stdio:['ignore','pipe','pipe']});let text=''
 c.stdout.on('data',d=>text+=d);c.stderr.on('data',d=>text+=d)
 c.on('error',reject);c.on('exit',code=>{if(code===0)done(text);else{for(const x of Object.values(env))if(x&&x.length>10)text=text.replaceAll(x,'[redacted]');reject(new Error(`Compose ${extra[0]} failed: ${text.slice(-1500)}`))}})
})
const sampleResources = async () => {
 const id=(await command(['ps','-q','hindsight'])).trim();assert.match(id,/^[a-f0-9]{12,64}$/)
 return new Promise((done,reject)=>{const c=spawn('docker',['stats','--no-stream','--format','{{json .}}',id],{env:childEnv,stdio:['ignore','pipe','pipe']});let text='';c.stdout.on('data',d=>text+=d);c.on('error',reject);c.on('exit',code=>{if(code===0)done(JSON.parse(text));else reject(new Error('Resource sampling failed'))})})
}
const endpoint='http://127.0.0.1:'+ports[0]
const api=async(path,method='GET',body)=>{
 const r=await fetch(endpoint+path,{method,headers:{authorization:'Bearer '+env.ROLE_HINDSIGHT_API_KEY,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)})
 if(!r.ok){await r.body?.cancel();throw new Error(`API HTTP ${r.status}`)}const text=await r.text();return text?JSON.parse(text):{}
}
const wait=ms=>new Promise(done=>setTimeout(done,ms))
const ready=async()=>{for(let n=0;n<120;n++){try{await api('/health');return}catch{}await wait(1000)}throw new Error('Isolated API readiness timeout')}
const poll=async(id,op,seconds=240)=>{for(let n=0;n<seconds;n++){const x=await api(`/v1/default/banks/${id}/operations/${op}`);if(x.status==='completed')return x;if(['failed','cancelled','not_found'].includes(x.status))throw new Error(`Operation ${x.status}`);await wait(1000)}throw new Error('Operation completion timeout')}
const report={version:1,project,startedAt:new Date().toISOString(),checks:{},load:[],completed:false,cleanup:false}
try{
 const initialization=performance.now()
 await command(['up','-d','db'])
 for(let n=0;n<40;n++){try{await command(['exec','-T','db','pg_isready','-U','hindsight','-d','hindsight']);break}catch{if(n===39)throw new Error('DB readiness timeout');await wait(500)}}
 await command(['up','-d','--no-deps','hindsight']);await ready();report.initializationMs=Math.round(performance.now()-initialization);report.initialResources=await sampleResources();console.log('isolated service ready')
 if(!process.argv.includes('--load-only')){
 await api(`/v1/default/banks/${bank}`,'PUT',{name:'Synthetic recovery acceptance'})
 const operation=randomUUID(),items=[0,1,2,3].map(i=>({document_id:'recovery-'+i,content:Array.from({length:20},(_,n)=>`合成恢复记录${i}-${n}：星舟第${i}组第${n}次会议决定把阅读辅助子项目${n}的负责人设为测试人物${i}-${n}，下次讨论将在星期四进行。`).join('\n'),tags:['scope:conversation']}))
 await api(`/v1/default/banks/${bank}/memories`,'POST',{async:true,operation_id:operation,items})
 let observed
 for(let n=0;n<600;n++){
  const list=await api(`/v1/default/banks/${bank}/operations?limit=100&exclude_parents=true`)
  const running=list.operations?.find(x=>x.status==='processing')
  observed=running?'processing':(await api(`/v1/default/banks/${bank}/operations/${operation}`)).status
  if(running){report.observedProcessingChild=running.id;break}
  if(observed==='completed')break
  await wait(100)
 }
 assert.equal(observed,'processing','Did not observe an in-flight operation; cannot claim crash recovery')
 await command(['kill','-s','SIGKILL','hindsight']);await command(['up','-d','--no-deps','hindsight']);await ready();await poll(bank,operation)
 report.checks.inFlightCrashRecovered=true;console.log('in-flight crash recovery PASS')
 const query={query:'阅读辅助项目下一次讨论的日期是什么？',budget:'low',max_tokens:2000}
 const before=await api(`/v1/default/banks/${bank}/memories/recall`,'POST',query)
 assert.ok(before.results.some(r=>r.document_id?.startsWith('recovery-')))
 const ids=before.results.map(r=>r.id).sort()
 const replay=await api(`/v1/default/banks/${bank}/memories`,'POST',{async:true,operation_id:operation,items});assert.equal(replay.operation_id,operation);await poll(bank,operation)
 const after=await api(`/v1/default/banks/${bank}/memories/recall`,'POST',query)
 assert.deepEqual(after.results.map(r=>r.id).sort(),ids)
 report.checks.recoveredOperationReplayNoNewFacts=true
 await command(['stop','hindsight'])
 await command(['exec','-T','db','pg_dump','-U','hindsight','-d','hindsight','-Fc','-f','/tmp/m3.dump'])
 await command(['cp','db:/tmp/m3.dump',join(run,'database.dump')])
 await command(['exec','-T','db','createdb','-U','hindsight','hindsight_restored'])
 await command(['exec','-T','db','pg_restore','-U','hindsight','-d','hindsight_restored','--no-owner','--exit-on-error','/tmp/m3.dump'])
 restoring=true;await command(['up','-d','--no-deps','hindsight']);await ready()
 const restored=await api(`/v1/default/banks/${bank}/memories/recall`,'POST',query)
 assert.deepEqual(restored.results.map(r=>r.id).sort(),ids)
 report.checks.backupRestoreRetainsSources=true;console.log('backup/restore PASS')
 }
 if(process.argv.includes('--load')){
  await api(`/v1/default/banks/${loadBank}`,'PUT',{name:'Synthetic index-only capacity acceptance'})
  await api(`/v1/default/banks/${loadBank}/config`,'PATCH',{updates:{retain_extraction_mode:'chunks',enable_observations:false,enable_auto_consolidation:false}})
  let count=0
  for(const target of [1000,10000]){
   const start=performance.now(),resources=[]
   while(count<target){
    const batch=Array.from({length:Math.min(500,target-count)},(_,i)=>{const n=count+i;return{document_id:`load-${n}`,content:`合成索引容量记录${n}。第${n}号阅读项目本周关注无障碍标注与段落导航，下一阶段验证语音朗读，项目编号M3-${n}。`}})
    const op=randomUUID();await api(`/v1/default/banks/${loadBank}/memories`,'POST',{async:true,operation_id:op,items:batch});await poll(loadBank,op,900);count+=batch.length;console.log(`load indexed ${count}/${target}`)
    resources.push(await sampleResources())
   }
   const times=[]
   for(let q=0;q<20;q++){const t=performance.now();await api(`/v1/default/banks/${loadBank}/memories/recall`,'POST',{query:`项目M3-${q*37}下一阶段关注什么？`,budget:'low',max_tokens:2000});times.push(performance.now()-t)}
   times.sort((a,b)=>a-b)
   const stats=await command(['ps','--format','json'])
   report.load.push({documents:count,mode:'chunks, no generation; capacity only, not extraction quality',incrementalIndexMs:Math.round(performance.now()-start-times.reduce((a,b)=>a+b,0)),queries:20,p50Ms:Math.round(times[9]),p95Ms:Math.round(times[18]),resources,resourceScope:'Sample after each batch, not a continuous peak measurement',composeStatus:stats})
   console.log(`load ${count} p50=${Math.round(times[9])} p95=${Math.round(times[18])}`)
  }
 }
 report.completed=true
}catch(error){report.error=error instanceof Error?error.message:'unknown service error'}
finally{
 if(report.error){try{let text=await command(['logs','--tail','80','hindsight']);for(const x of Object.values(env))if(x&&x.length>10)text=text.replaceAll(x,'[redacted]');writeFileSync(join(run,'service-error.log'),text)}catch{}}
 try{await command(['down','-v','--remove-orphans']);report.cleanup=true}catch{report.cleanup=false}
 report.finishedAt=new Date().toISOString();writeFileSync(join(run,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({report:join(run,'report.json'),checks:report.checks,completed:report.completed,error:report.error,cleanup:report.cleanup}))
}
if(!report.completed||!report.cleanup)process.exitCode=1
