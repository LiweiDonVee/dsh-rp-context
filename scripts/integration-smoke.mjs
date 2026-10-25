import {spawn,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'

const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]}
const root=process.cwd(),manifest=JSON.parse(await readFile('package.json','utf8'))
const paths={database:option('--database-tgz')??process.env.DSH_DATABASE_TGZ,lastStep:option('--last-step-tgz')??process.env.DSH_LAST_STEP_TGZ,context:option('--context-tgz')??process.env.DSH_CONTEXT_TGZ??resolve('artifacts',`${manifest.name}-${manifest.version}.tgz`)}
if(!paths.database||!paths.lastStep)throw Error('Provide --database-tgz and --last-step-tgz (or DSH_DATABASE_TGZ/DSH_LAST_STEP_TGZ).')
const packages=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([name,path])=>[name,{path:resolve(path),sha256:createHash('sha256').update(await readFile(path)).digest('hex')}])) )
const home=resolve('.runtime/context-real-stack-'+Date.now()),evidence=resolve(option('--evidence-dir')??'.runtime/integration-evidence')
const cli=option('--cli')??process.env.DSH_BIN??(process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'):'dsh')
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'local-integration-unused'}
const quote=value=>process.platform==='win32'?`"${value}"`:value
const redact=value=>String(value).replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]').replace(/(Bearer\s+)[\w.-]+/giu,'$1[REDACTED]')
const assert=(condition,message)=>{if(!condition)throw Error(message)}
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
await writeFile(join(home,'package.json'),JSON.stringify({name:'context-real-stack-home',private:true,type:'module'}))
let host,browser,page,logs='',stage='install',result={passed:false,packages,home,scope:'real Database + Context + LastStep; synthetic local main tool/model; no rpGM'},pageErrors=[]
const save=()=>writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2))
const artifact=(name,value)=>writeFile(join(evidence,name+'.json'),JSON.stringify(value,null,2))
const kill=child=>new Promise(done=>{if(!child?.pid)return done();if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>done());else{child.kill('SIGTERM');done()}})
const cliRun=parameters=>new Promise((done,reject)=>{
 const child=spawn(quote(cli),parameters.map(quote),{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']});let output=''
 const timer=setTimeout(async()=>{await kill(child);reject(Error('CLI timed out'))},60_000)
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>output+=data)
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);if(code===0)done(output.trim());else reject(Error('CLI failed: '+redact(output.slice(-6000))))})
})
async function startHost(patch){
 logs='';host=spawn(quote(cli),['--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'].map(quote),{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']})
 for(const stream of[host.stdout,host.stderr])stream.on('data',data=>logs+=data)
 const deadline=Date.now()+40_000
 while(Date.now()<deadline){const url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(url)return url;if(host.exitCode!==null)throw Error('Native host exited');await new Promise(done=>setTimeout(done,100))}
 throw Error('Host startup timed out')
}
const httpCalls=[]
const retrieval=createServer(async(request,response)=>{
 try{
  const chunks=[];for await(const chunk of request)chunks.push(chunk)
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));httpCalls.push({path:request.url,input})
  assert(!JSON.stringify(input).includes('NO_PROVIDER_OR_WRITER_DISABLED_SENTINEL'),'Disabled text was sent to retrieval HTTP')
  response.setHeader('content-type','application/json')
  if(request.url==='/v1/embeddings'){
   assert(input.model==='integration-embedding','Wrong embedding model')
   response.end(JSON.stringify({data:input.input.map((text,index)=>({index,embedding:text.includes('buried-observatory')||text.includes('SECRET OBSERVATORY FACT')?[0,1]:[1,0]}))}));return
  }
  if(request.url==='/v1/rerank'){
   assert(input.model==='integration-rerank','Wrong rerank model')
   response.end(JSON.stringify({results:input.documents.map((text,index)=>({index,relevance_score:text.includes('SECRET OBSERVATORY FACT')?(input.query.includes('buried-observatory')?100000:-100000):1000-index}))}));return
  }
  response.statusCode=404;response.end('{}')
 }catch(error){response.statusCode=500;response.end(JSON.stringify({error:error.message}))}
})
await new Promise(done=>retrieval.listen(0,'127.0.0.1',done))
try{
 result.dshVersion=await cliRun(['--version']);assert(result.dshVersion==='0.2.1-rc.3','This acceptance targets actual rc.3')
 for(const input of Object.values(packages))await cliRun(['plugin','--profile','web','add',input.path])
 const fixture=join(home,'integration-probe.mjs');await writeFile(fixture,await readFile('tests/fixtures/integration-probe.mjs'))
 const providerURL=`http://127.0.0.1:${retrieval.address().port}/v1`,patch=join(home,'integration.patch.yml')
 await writeFile(patch,`- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: tools\n  config:\n    mode: native\n- id: agent-default-model\n  config:\n    provider: context-integration-local\n    model: main\n- id: rp-database\n  config:\n    embedding:\n      baseURL: ${providerURL}\n      model: integration-embedding\n    reranking:\n      baseURL: ${providerURL}\n      model: integration-rerank\n- id: rp-last-step\n  config:\n    maxAssemblySteps: 2\n- insert:\n    - id: context-integration-probe\n      name: ${JSON.stringify(fixture.replaceAll('\\','/'))}\n    - id: context-integration-story\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: context-integration-story\n        name: Real plugin integration fixture\n        description: Explicit synthetic local main action, real plugins\n        plugins: []\n`)
 stage='host-start';const url=await startHost(patch)
 browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15_000);page.on('pageerror',error=>pageErrors.push(error.message))
 await page.addInitScript(()=>{Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target);const observed=row=>load(row.id!=='@deepseek-ai/dsh-client-ui-workspace'?row:{...row,factory(require){const plugin=row.factory(require);return{...plugin,apply(ctx){window.__workspaceCtx=ctx;return plugin.apply(ctx)}}}});Object.defineProperty(target,'load',{configurable:true,get:()=>observed,set(next){load=next.bind(target)}})}})})
 async function open(address){await page.goto(address,{waitUntil:'networkidle'});const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:2000}).catch(()=>{});if(await preview.isVisible())await preview.click()}
 await open(url)
 const request=(path,input)=>page.evaluate(async({path,input})=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(60_000)}),value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value.data??value},{path,input})
 const probe=input=>request('api/context-integration',input)
 const counts=snapshot=>Object.fromEntries(['main','prepare','summarize','assemble','writer'].map(name=>[name,snapshot.calls.filter(call=>call.stage===name).length]).concat([['facts',snapshot.facts.length]]))
 async function settled(sessionId,predicate){let current;const until=Date.now()+12_000;do{current=await probe({action:'snapshot',sessionId});if(predicate(current))return current;await new Promise(done=>setTimeout(done,50))}while(Date.now()<until);await artifact('unsettled',current);throw Error('Actual plugin outcome did not settle')}
 const setup=await probe({action:'setup'}),sessionId=setup.sessionId;result.sessionId=sessionId;result.capabilities=setup.capabilities;await artifact('setup',setup)
 const note=text=>probe({action:'note',sessionId,text})
 const run=(runId,mode='success',presentationId)=>probe({action:'run',sessionId,runId,mode,presentationId,text:mode==='retry'?'Retry frozen prose only.':'Check courtyard.'})
 stage='successful-real-terminal'
 await note('First real plugin owner note.')
 await run('success-1');const first=await settled(sessionId,value=>value.context.authorNote?.status==='consumed'&&value.context.history.length===1)
 await artifact('first-success',first)
 const firstReceipt=first.last.presentations.find(row=>row.status==='complete'),firstMaterial=first.materials.find(row=>row.presentationId===firstReceipt.id),firstProse=first.context.history[0].text
 assert(firstMaterial.contextPreparation.database.binding.sources.length===2,'v2 binding missing in real LS frozen material')
 assert(firstMaterial.contextPreparation.materials.entries.filter(row=>row.id==='same').length===2,'Qualified selected IDs collided')
 assert(firstMaterial.contextPreparation.materials.entries.some(row=>row.ref.entryId==='required'),'Required world union missing')
 assert(firstMaterial.contextPreparation.degraded.length===0,'Real retrieval silently degraded')
 assert(!JSON.stringify(first.database.changes).includes('SHOULD_NOT_STAGE')&&!JSON.stringify(first.database.changes).includes('FORBIDDEN FACT EDIT'),'Rejected material batch persisted authoritative changes')
 assert(firstMaterial.contextPreparation.candidates.some(row=>row.key===JSON.stringify(['world','outside'])),'Recorded pool lacks discovered outside reference')
 assert(first.context.authorNote.claimedBy===firstReceipt.id,'Canonical acceptance did not consume initial real claim')
 const firstPrefix=first.events.findLast(event=>event.type==='turn/end').seq
 stage='assembly-before-freeze-failure'
 await note('Owner note released if assembly never freezes.')
 await run('assembly-failure','assembly-fail');const prefailed=await settled(sessionId,value=>value.last.presentations.some(row=>row.status==='failed')&&value.context.authorNote?.status==='pending')
 await artifact('assembly-failure',prefailed)
 const preReceipt=prefailed.last.presentations.find(row=>row.status==='failed'),preMaterial=prefailed.materials.find(row=>row.presentationId===preReceipt.id)
 assert(preMaterial.contextPreparation?.authorNote&&preMaterial.compiled===null,'Expected real Context capture but no compiled LS snapshot')
 assert(prefailed.context.history.length===1,'Failed pre-freeze presentation became narrative')
 assert(prefailed.calls.filter(call=>call.stage==='writer').length===1,'Writer ran before assembly succeeded')
 stage='assembly-recovery-new-attempt'
 await run('success-2');const recovered=await settled(sessionId,value=>value.context.authorNote?.status==='consumed'&&value.context.history.length===2)
 await artifact('assembly-recovered',recovered)
 const recoveryPrefix=recovered.events.findLast(event=>event.type==='turn/end').seq
 stage='writer-after-freeze-failure'
 await note('Captured old note for writer retry.')
 await run('writer-failure','writer-fail');const failed=await settled(sessionId,value=>value.context.authorNote?.status==='claimed'&&value.last.presentations.some(row=>row.status==='failed'&&row.canRetry))
 await artifact('writer-failure',failed)
 const failedReceipt=failed.last.presentations.find(row=>row.status==='failed'&&row.canRetry),failedMaterial=failed.materials.find(row=>row.presentationId===failedReceipt.id),beforeRetry=counts(failed)
 assert(Array.isArray(failedMaterial.compiled?.messages),'Post-freeze failure lacks compiled snapshot')
 assert(failed.context.history.length===2,'Failed writer became narrative')
 assert(failedMaterial.contextPreparation.materials.history.find(row=>row.id===first.context.history[0].id)?.mode==='summary','Context did not summarize older accepted prose')
 assert(failed.calls.some(call=>call.stage==='main'&&call.runId==='writer-failure'&&call.toolTexts.includes(firstProse)),'Context window removed prose from actual main model input')
 await probe({action:'editAfterFreeze',sessionId});await note('Next unrelated owner note; preserve it through old retry.')
 stage='real-native-writer-retry'
 await run('retry-dispatch','retry',failedReceipt.id);const retried=await settled(sessionId,value=>value.context.history.length===3&&value.context.authorNote?.status==='pending')
 await artifact('writer-retried',retried)
 const afterRetry=counts(retried),retryReceipt=retried.last.presentations.find(row=>row.status==='complete'&&row.rewriteOf===failedReceipt.id),retryMaterial=retried.materials.find(row=>row.presentationId===retryReceipt?.id)
 assert(retryReceipt,'Real native rewrite did not canonically complete')
 for(const field of ['prepare','assemble','facts'])assert(afterRetry[field]===beforeRetry[field],`Retry repeated ${field}`)
 assert(afterRetry.writer===beforeRetry.writer+1,'Retry did not call writer exactly once')
 assert(JSON.stringify(retryMaterial.contextPreparation)===JSON.stringify(failedMaterial.contextPreparation),'Retry reconstructed context instead of frozen snapshot')
 assert(!JSON.stringify(retryMaterial.contextPreparation.materials).includes('OVERLAY AFTER FREEZE'),'Later overlay leaked into frozen material')
 const exported=await probe({action:'contextExport',sessionId}),claim=exported.payload.sessions[0].state.noteClaims[failedMaterial.contextPreparation.authorNote.claimId]
 assert(claim.status==='consumed'&&claim.outcomePresentationId===retryReceipt.id,'Accepted retry did not consume exact old claim with real frozen proof')
 assert(retried.context.authorNote.text.startsWith('Next unrelated'),'Accepted old retry consumed replacement owner note')
 stage='duplicate-retry-rejection'
 await run('duplicate-retry','retry',failedReceipt.id);const duplicate=await probe({action:'snapshot',sessionId});await artifact('duplicate-retry',duplicate)
 const duplicateCounts=counts(duplicate)
 for(const field of ['prepare','assemble','writer','facts'])assert(duplicateCounts[field]===afterRetry[field],`Ineligible duplicate retry ran ${field}`)
 assert(duplicate.context.history.length===3,'Ineligible retry changed narrative history')
 const originals=await probe({action:'sources',worldSourceId:setup.world.sourceId,actorSourceId:setup.actor.sourceId})
 assert(originals.world.source.rawText===setup.rawWorld&&originals.actor.source.rawText===setup.rawActor,'Source originals changed')
 assert(originals.world.source.sha256===createHash('sha256').update(setup.rawWorld).digest('hex')&&originals.actor.source.sha256===createHash('sha256').update(setup.rawActor).digest('hex'),'Original source hashes changed')
 for(const expected of setup.protectedFacts)assert(duplicate.database.entries.find(row=>row.ref.sourceKey==='@session'&&row.id===expected.id)?.content===expected.content,'Protected fact body changed')
 stage='actual-canonical-fork-prefix'
 const child=await probe({action:'fork',sessionId,atSeq:firstPrefix}),childState=await probe({action:'snapshot',sessionId:child.sessionId});await artifact('fork-first-prefix',childState)
 assert(childState.context.history.length===1&&childState.context.history[0].text===firstProse,'Fork canonical prefix narrative incorrect')
 assert(childState.database.entries.find(row=>row.ref.sourceKey==='@session'&&row.id==='turn-counter').content==='1','Fork inherited later working state')
 assert(childState.database.entries.find(row=>row.ref.sourceKey==='world'&&row.id==='same').content==='SELECTED WORKING TEXT success-1','Fork flattened later world overlay')
 const rewind=await probe({action:'fork',sessionId,atSeq:recoveryPrefix}),rewound=await probe({action:'snapshot',sessionId:rewind.sessionId});await artifact('rewound-prefix',rewound)
 assert(rewound.context.history.length===2,'Prefix rollback included later retry narrative')
 const priorNative=await probe({action:'snapshot',sessionId});await artifact('before-restart',priorNative)
 const toolCounts=Object.fromEntries(['context_fixture_fact','rp_present'].map(name=>[name,priorNative.events.filter(event=>event.type==='tool/call'&&event.data.name===name).length]))
 const acceptedResults=priorNative.events.filter(event=>event.type==='tool/result'&&event.data?.meta?.rpLastStep?.record?.status==='complete'&&!event.data.message?.isError)
 assert(toolCounts.context_fixture_fact===4&&toolCounts.rp_present===6&&acceptedResults.length===3,'Actual canonical tool/result counts do not match fixture operations')
 assert(priorNative.database.entries.find(row=>row.ref.sourceKey==='@session'&&row.id==='turn-counter').content==='4','Allowed tool counter was repeated or lost')
 const modelConfigs=[...new Map(priorNative.materials.flatMap(material=>[...Object.entries(material.models??{}).map(([stage,config])=>({stage,...config})),...Object.entries(material.contextPreparation?.models??{}).map(([stage,config])=>({stage:'context.'+stage,...config}))]).map(config=>[JSON.stringify(config),config])).values()]
 assert(modelConfigs.every(config=>config.provider==='context-integration-local'&&config.model==='main'),'Recorded actual model differs from the explicit local route')
 stage='real-material-native-panel'
 await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),sessionId)
 await page.getByRole('button',{name:'打开主动上下文',exact:true}).click()
 const panel=page.locator('[data-rp-context-root]');await panel.waitFor({state:'visible'})
 await panel.getByRole('region',{name:'作者注',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'real-context-author-note.png')})
 await panel.getByRole('button',{name:'查看冻结材料',exact:true}).click();const frozen=panel.getByRole('region',{name:'冻结写作材料'});await frozen.waitFor()
 assert((await frozen.textContent()).includes('sourceKey'),'Real native material panel lacks qualified refs')
 assert((await frozen.textContent()).includes('Use concise third-person prose.'),'Real native material panel lacks frozen modules')
 await page.screenshot({path:join(evidence,'real-context-material.png')})
 await frozen.getByText('模块与编译输入',{exact:true}).click();await frozen.getByText('实际模型与用量记录',{exact:true}).click()
 await frozen.getByText('模块与编译输入',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'real-context-compiled.png')})
 stage='real-stack-cold-restart'
 await kill(host);host=undefined;await open(await startHost(patch))
 const cold=await probe({action:'snapshot',sessionId});await artifact('cold-restart',cold)
 assert(JSON.stringify(cold.events)===JSON.stringify(priorNative.events),'Actual stack event prefix changed on cold restart')
 assert(cold.context.history.length===3&&cold.calls.length===0&&cold.facts.length===0,'Cold read replayed work or lost accepted prose')
 assert(cold.context.authorNote.text.startsWith('Next unrelated')&&cold.context.authorNote.status==='pending','Cold note lineage incorrect')
 assert(httpCalls.some(call=>call.path==='/v1/embeddings')&&httpCalls.some(call=>call.path==='/v1/rerank'),'Configured HTTP providers were not called')
 assert(!JSON.stringify(httpCalls).includes('NO_PROVIDER_OR_WRITER_DISABLED_SENTINEL'),'Disabled content escaped to providers')
 assert(pageErrors.length===0,'Native UI page errors: '+JSON.stringify(pageErrors))
 result={...result,passed:true,stage:'complete',counts:duplicateCounts,canonicalCounts:{...toolCounts,acceptedResults:acceptedResults.length},modelConfigs,http:{embedding:httpCalls.filter(call=>call.path==='/v1/embeddings').length,rerank:httpCalls.filter(call=>call.path==='/v1/rerank').length},checks:{realV2:true,duplicateRawIds:true,requiredUnion:true,disabledExcluded:true,protectedMixedBatchRejected:true,outsideCandidateSearch:true,originalsPreserved:true,mainInputPreserved:true,realTerminalAcceptance:true,authorNoteDoubleProof:true,beforeFreezeRelease:true,afterFreezeClaim:true,writerOnlyStageRetry:true,retryUsesFrozenSnapshot:true,replacementNotePreserved:true,duplicateRetryRejected:true,forkCausalPrefix:true,rewoundPrefix:true,realNativeMaterialPanel:true,coldRestartExactPrefix:true,coldModelCalls:0,coldToolCalls:0},deferred:['Production GM factual turn/receipt: await coordinator-provided GM-B package','Production adopted revision dispatch / automatic LS composition inheritance / complete restore: await accepted LS-B package'],pageErrors}
 await artifact('http-requests',httpCalls);await save();console.log(JSON.stringify(result))
}catch(error){
 if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})
 result={...result,passed:false,stage,error:redact(error.message),pageErrors};await save();await artifact('http-requests',httpCalls)
 await writeFile(join(evidence,'host-redacted.log'),redact(logs.slice(-20000)));console.error(JSON.stringify(result));process.exitCode=1
}finally{await browser?.close();await kill(host);retrieval.closeAllConnections();await new Promise(done=>retrieval.close(done))}
