// Export compact, synthetic evidence; raw prompts and local authentication URLs stay in .tmp.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const [manifestPath, outputPath] = process.argv.slice(2)
if (!manifestPath || !outputPath) throw new Error('Usage: node summarize.mjs RUNS.json OUTPUT.json')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const percentile = (xs, p) => xs.length ? [...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1] : null
const totals = () => ({ calls:0, withUsage:0, uncachedInput:0, cachedInput:0, output:0, errors:0, durationsMs:[] })
const add = (group, call, backend) => {
  group.calls++
  if (call.error || (backend && call.status !== 'success')) group.errors++
  const ms = backend ? call.duration_ms : call.finishedAt - call.startedAt
  if (Number.isFinite(ms)) group.durationsMs.push(ms)
  const u = backend ? call : call.usage
  if (u && (backend ? u.input_tokens != null : u.inputTokens != null)) {
    group.withUsage++
    const cached = backend ? u.cached_tokens ?? 0 : u.cacheReadTokens ?? 0
    group.cachedInput += cached
    // Hindsight exposes total input; DSH exposes uncached input separately.
    group.uncachedInput += backend ? u.input_tokens-cached : u.inputTokens
    group.output += backend ? u.output_tokens ?? 0 : u.outputTokens ?? 0
  }
}
const finish = group => {
  const {durationsMs,...rest} = group
  return {...rest,p50Ms:percentile(durationsMs,.5),p95Ms:percentile(durationsMs,.95),knownUsageEstimateUSD:(rest.uncachedInput*.15+rest.cachedInput*.003+rest.output*.6)/1e6}
}
const output = {version:1,date:'2026-11-15',scope:'M3 Linux/WSL Web synthetic acceptance; not M4',pricing:{source:'https://api-docs.deepseek.com/quick_start/pricing/',model:'deepseek-flash',usdPerMillion:{uncachedInput:.15,cachedInput:.003,output:.6},scope:'Sunday off-peak list-price estimate, not provider invoice; missing usage is unknown, not zero'},runs:[]}
for (const entry of read(manifestPath)) {
  const path = join(entry.directory,'report.json'), r=read(path), groups={}
  const addCall=(key,c,b)=>add(groups[key]??=(totals()),c,b)
  const callsPath=join(entry.directory,'llm-calls.json')
  if(existsSync(callsPath))for(const c of read(callsPath))addCall(`DSH:${c.provider}:${c.purpose}`,c,false)
  const tracesPath=join(entry.directory,'model-traces.json')
  if(existsSync(tracesPath))for(const c of read(tracesPath).items??[])addCall(`Hindsight:${c.provider}:${c.scope}`,c,true)
  const metrics=r.runtimeMetrics
  output.runs.push({label:entry.label,path,sha256:hash(path),completed:r.completed??r.summary?.passedThreshold,cleanup:r.cleanup??r.memoryBankRemoved,checks:r.checks,
    costCoverage:!existsSync(callsPath)&&!existsSync(tracesPath)?'No per-request trace export in this run; API cost unknown. Chunks-only load adds no extraction calls.':entry.label==='B2-reflection-restart'?'Earlier observer overwrote pre-restart requests; recovery requests only, not total run cost.':'Observed requests only; absent usage and provider-internal retries require invoice reconciliation.',
    fixtureSha256:r.fixtureSha256,sourceHashes:r.sourceHashes,parameters:r.parameters,summary:r.summary,
    variants:r.variants,backendTraceRows:r.backendTraceRows??r.modelTraceRows,backendTraceTotal:r.backendTraceTotal??r.modelTraceTotal,
    resources:metrics?{rssBytes:metrics.rssBytes,eventLoopP50Ms:metrics.eventLoopP50Ms,eventLoopP95Ms:metrics.eventLoopP95Ms,eventLoopMaxMs:metrics.eventLoopMaxMs}:undefined,
    initializationMs:r.initializationMs,initialMemory:r.initialResources?.MemUsage,
    load:r.load?.map(x=>({documents:x.documents,mode:x.mode,incrementalIndexMs:x.incrementalIndexMs,queries:x.queries,p50Ms:x.p50Ms,p95Ms:x.p95Ms,memorySamples:x.resources?.map(v=>v.MemUsage),resourceScope:x.resourceScope})),
    calls:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,finish(v)])),
    trajectory:r.turns?.map((t,i)=>({turn:i+1,revision:t.record.revision,evidenceRevision:t.record.evidenceRevision,contextEvents:t.contextEvents,tools:t.tools})),
    finalBeliefs:r.turns?.at(-1)?.record.beliefs,
    outcomes:r.turns?.at(-1)?.record.outcomes,
    methodTrials:r.turns?.at(-1)?.record.methodTrials,
    replies:r.turns?.map((t,i)=>({turn:i+1,input:t.input,reply:t.reply})),
  })
}
// Exploratory failures are retained, not silently dropped or called a controlled failure rate.
output.exploratoryInventory = readdirSync('.tmp/m3',{withFileTypes:true}).filter(x=>x.isDirectory()&&x.name.startsWith('dsh-')&&existsSync(join('.tmp/m3',x.name,'report.json'))).map(x=>{
  const path=join('.tmp/m3',x.name,'report.json'),r=read(path)
  return {path,sha256:hash(path),mode:r.mode,scenario:r.scenario,completed:r.completed,finishedAt:r.finishedAt,errorDigest:r.error?createHash('sha256').update(r.error).digest('hex'):undefined,applicationSha256:r.sourceHashes?.['role-agent/lib/index.js']}
})
writeFileSync(outputPath,JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify({output:outputPath,runs:output.runs.length,exploratoryReports:output.exploratoryInventory.length}))
