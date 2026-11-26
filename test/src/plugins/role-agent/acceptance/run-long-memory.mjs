// Opt-in M5: native Session/domain + real Hindsight, isolated synthetic material.
import assert from 'node:assert/strict'
import { readFileSync,writeFileSync,appendFileSync,mkdirSync,mkdtempSync } from 'node:fs'
import {resolve,join} from 'node:path'
import {parseEnv} from 'node:util'
import {randomUUID,createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import {JsonStorageBackend} from '@deepseek-ai/dsh-storage-json'
import {DomainFacility} from '@deepseek-ai/dsh-storage-domain'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage,createAssistantMessage,createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {RoleEngine,Hindsight,initial,spec,digest} from "../../../../../plugins/role-agent/lib/index.js"
if(!process.argv.includes('--live'))throw Error('Pass --live for paid synthetic Hindsight extraction')
const env=parseEnv(readFileSync('plugins/role-agent/deploy/hindsight/.env','utf8')),key=env.ROLE_HINDSIGHT_API_KEY
const endpoint=`http://127.0.0.1:${env.HINDSIGHT_API_PORT||8888}`
mkdirSync('.tmp/m5',{recursive:true});const run=mkdtempSync(resolve('.tmp/m5/long-memory-')),bank='role-m5-'+randomUUID()
const report={version:1,startedAt:new Date().toISOString(),bank,checks:{},queries:[],cleanup:false,scope:'Real Hindsight + native domain/Session, P3 disabled; full Agent/tools tested separately',sourceSha256:createHash('sha256').update(readFileSync('plugins/role-agent/lib/index.js')).digest('hex')}
const api=async(path,method='GET')=>{const r=await fetch(`${endpoint}/v1/default/banks/${bank}${path}`,{method,headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(120000)});if(!r.ok){await r.body?.cancel();throw Error('API HTTP '+r.status)}const t=await r.text();return t?JSON.parse(t):{}}
const ctx=new Context(),storage=new Storage(ctx),disk=new JsonStorageBackend(join(run,'domain'));storage.backend.register('json',disk)
const facility=new DomainFacility(ctx,{backend:'json'});let domain=await facility.open(spec),table=domain.table('characters')
await table.put('lan',{...initial('lan','role-lan'),namespace:bank});new SessionStore(ctx)
const session=ctx.sessions.create(SessionId(randomUUID()),{meta:{cwd:run}})
ctx.on('session/event',(s,e)=>appendFileSync(join(run,s.id+'.jsonl'),JSON.stringify(e)+'\n'),{global:true})
const read=async(id,start,length)=>readFileSync(join(run,id+'.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).slice(start,start+length)
const memory=new Hindsight({endpoint,bankId:bank,apiKey:key,timeoutMs:120000,maxResponseBytes:1048576,pollMs:500,maxPolls:240,maxTokens:2000})
const calls=[];const backend={prepare:s=>memory.prepare(s),retain:async(ep,text,s)=>{await memory.retain(ep,text,s);calls.push(ep.operationId);console.log('indexed part '+calls.length)},recall:(...a)=>memory.recall(...a),remove:(...a)=>memory.remove(...a)}
const options={characterId:'lan',batchTurns:1000,maxEvidenceChars:24000,memoryPartChars:8000,maxBeliefs:24,maxHits:5,maxResultChars:8000,maxWorkPerDrain:1,maxAttempts:3}
const ports={backend,read,reflect:async()=>{throw Error('P3 disabled in source test')},route:()=>undefined,error:()=>{}}
let engine=new RoleEngine(table,options,ports);await engine.bind(session.id)
const facts=[['银杏项目的实验负责人叫什么？','开头记录：银杏项目的实验负责人叫白榆。'],['琥珀项目的校验短语是什么？','中段记录：琥珀项目的校验短语是落日纸船。'],['星桥项目的资料保管员叫什么？','末尾记录：星桥项目的资料保管员叫蓝禾。']]
const material=facts[0][1]+'\n'+'这是一段合成填充说明，只表示材料文本，不是行动记录。'.repeat(550)+'\n'+facts[1][1]+'\n'+'这是另一段合成说明，不引入新的事实或权限。'.repeat(550)+'\n'+facts[2][1]
try{
 session.append('turn/start',{turn:1});session.append('user/message',createUserMessage({content:[{type:'text',text:'请阅读这份合成长材料并保留可追溯来源。'}],source:{kind:'user'}}),{surfaceOp:'append'})
 session.append('tool/call',{turn:1,step:1,callId:ToolCallId('m5-long'),name:'read',arguments:'{"file_path":"synthetic-only.txt"}'})
 session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:ToolCallId('m5-long'),content:[{type:'text',text:material}],isError:false})},{surfaceOp:'append'})
 session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'已收到工具返回的合成材料，未发生其他行动。'}],source:{provider:'fixture',model:'synthetic'}}),stream:[]},{surfaceOp:'append'})
 session.append('turn/end',{turn:1,reason:{kind:'completed'}});await engine.capture(session.id);await engine.drain()
 const ep=Object.values(engine.record.episodes)[0];assert.ok(ep.parts?.length>1);assert.equal(ep.indexed,false)
 report.checks.partialAcknowledgement=true;report.characters=material.length;report.parts=ep.parts.length
 await engine.close();await domain.close();domain=await facility.open(spec);table=domain.table('characters');options.maxWorkPerDrain=32;engine=new RoleEngine(table,options,ports)
 await engine.capture(session.id);await engine.drain();assert.ok(engine.record.episodes[ep.id].indexed)
 assert.equal(new Set(calls).size,calls.length);assert.equal(calls.length,ep.parts.length);report.checks.reopenResumesWithoutDuplicateWrites=true
 for(const [query,marker]of facts){const hits=await engine.recall(query,new AbortController().signal);assert.ok(hits.hits.length);assert.ok(hits.hits.some(h=>h.ranges?.length));
  const source=ep.sources.find(s=>readFileSync(join(run,s.sessionId+'.jsonl'),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s))[s.seq]?.type==='tool/result')
  const original=(await engine.evidence([engine.record.episodes[ep.id]],Infinity)).find(e=>e.source.id===source.id).text,start=original.indexOf(marker)
  const expanded=await engine.readSources([source.id],[{sourceId:source.id,start,end:start+marker.length}]);assert.equal(expanded.sources[0].text,marker)
  const expectedParts=engine.record.episodes[ep.id].parts.filter(p=>p.ranges.some(r=>r.sourceId===source.id&&r.start<=start&&r.end>=start+marker.length)).map(p=>p.documentId)
  const raw=await memory.recall(query,new AbortController().signal);assert.ok(raw.some(h=>expectedParts.includes(h.documentId)),'required range was not semantically recalled')
  report.queries.push({query,marker,expectedParts,found:raw.map(h=>h.documentId),expanded:true});console.log('recall PASS '+query)
 }
 report.checks.headMiddleTailSemanticRecall=true;report.checks.rangeExpansionExact=true
 session.append('turn/start',{turn:2});session.append('user/message',createUserMessage({content:[{type:'text',text:'更正：撤回前面那份合成材料，不再作为依据。'}],source:{kind:'user'}}),{surfaceOp:'append'});session.append('turn/end',{turn:2,reason:{kind:'cancelled'}})
 const byEvent=(await read(session.id,0,session.seq)).filter(e=>e.type==='user/message').at(-1),by={id:digest(session.id).slice(0,16)+':'+byEvent.seq,sessionId:session.id,seq:byEvent.seq,kind:'user'}
 await engine.correct([ep.sources[0].id],by,'Synthetic source withdrawal');assert.deepEqual((await engine.recall(facts[1][0],new AbortController().signal)).hits,[]);report.checks.immediateRangeBarrier=true
 await table.update('lan',r=>({...r,priority:false}));await engine.drain()
 assert.ok(engine.record.episodes[ep.id].parts.every(p=>!p.indexed));for(const part of ep.parts){const r=await fetch(`${endpoint}/v1/default/banks/${bank}/documents/${part.documentId}`,{headers:{authorization:`Bearer ${key}`}});assert.equal(r.status,404);await r.body?.cancel()}
 report.checks.allPartsDeleted=true
 const traces=await api('/llm-requests?limit=500');writeFileSync(join(run,'model-traces.json'),JSON.stringify(traces,null,2)+'\n');report.traceRows=traces.items.length;report.traceTotal=traces.total
}catch(error){report.error=String(error).replaceAll(key,'[redacted]')}
finally{await engine.close();await domain.close();await disk.close();try{await api('','DELETE');report.cleanup=true}catch{}report.finishedAt=new Date().toISOString();writeFileSync(join(run,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:join(run,'report.json'),checks:report.checks,error:report.error,cleanup:report.cleanup}))}
if(report.error||!report.cleanup)process.exitCode=1
