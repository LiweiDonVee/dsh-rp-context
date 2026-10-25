import {spawn,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'

const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]}
const root=process.cwd(),manifest=JSON.parse(await readFile('package.json','utf8'))
const archive=resolve(option('--context-tgz')??process.env.DSH_CONTEXT_TGZ??join('artifacts',`${manifest.name}-${manifest.version}.tgz`))
const sha256=createHash('sha256').update(await readFile(archive)).digest('hex')
const home=resolve('.runtime/context-export-lock-'+Date.now()),evidence=resolve(option('--evidence-dir')??'.runtime/export-lock-evidence')
const cli=process.env.DSH_BIN??(process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'):'dsh')
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'unused-export-lock-local'}
const quote=value=>process.platform==='win32'?`"${value}"`:value
const redact=value=>String(value).replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]')
const assert=(condition,message)=>{if(!condition)throw Error(message)}
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
await writeFile(join(home,'package.json'),JSON.stringify({name:'context-export-lock-home',private:true,type:'module'}))
let host,browser,page,logs='',stage='install',request,sessionId,busy=false,result={passed:false,archive,sha256,home,scope:'actual rc.3 SDK maintenance composition; Context only; not aggregate SavedStory'}
const kill=child=>new Promise(done=>{if(!child?.pid)return done();if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>done());else{child.kill('SIGTERM');done()}})
const runCli=parameters=>new Promise((done,reject)=>{
 const child=spawn(quote(cli),parameters.map(quote),{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']});let output=''
 const timer=setTimeout(async()=>{await kill(child);reject(Error('CLI timed out'))},60_000)
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>output+=data)
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);if(code===0)done(output.trim());else reject(Error('CLI failed: '+redact(output.slice(-6000))))})
})
try{
 result.hostVersion=await runCli(['--version']);assert(result.hostVersion==='0.2.1-rc.3','This evidence targets actual rc.3')
 await runCli(['plugin','--profile','web','add',archive])
 const fixture=join(home,'export-lock-probe.mjs');await writeFile(fixture,await readFile('tests/fixtures/export-lock-probe.mjs'))
 const patch=join(home,'export-lock.patch.yml')
 await writeFile(patch,`- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: context-export-lock-local\n    model: main\n- insert:\n    - id: context-export-lock-probe\n      name: ${JSON.stringify(fixture.replaceAll('\\','/'))}\n    - id: context-export-lock-story\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: context-export-lock-story\n        name: Export lock fixture\n        plugins: []\n`)
 stage='host-start';host=spawn(quote(cli),['--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'].map(quote),{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']})
 for(const stream of[host.stdout,host.stderr])stream.on('data',data=>logs+=data)
 let address;const until=Date.now()+40_000
 while(Date.now()<until){address=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(address)break;if(host.exitCode!==null)throw Error('Host exited');await new Promise(done=>setTimeout(done,100))}
 assert(address,'Host startup timed out')
 browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
 page=await browser.newPage();await page.goto(address,{waitUntil:'networkidle'})
 const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:2000}).catch(()=>{});if(await preview.isVisible())await preview.click()
 request=input=>page.evaluate(async input=>{const response=await fetch('api/context-export-lock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30_000)});return response.json()},input)
 const created=await request({action:'create'});assert(!created.error,'Fixture setup failed: '+JSON.stringify(created));sessionId=created.sessionId
 stage='standalone-export';const standalone=await request({action:'export',sessionId});assert(standalone.ok,'Standalone export failed: '+JSON.stringify(standalone))
 assert(standalone.modelCalls===0&&standalone.ownerScopes===0,'Standalone export unexpectedly drove work')
 stage='coordinator-held-maintenance';const coordinated=await request({action:'underMaintenance',sessionId})
 assert(coordinated.ok,'Nested owner scope failed: '+JSON.stringify(coordinated))
 assert(coordinated.insideStatus==='idle'&&coordinated.ownerScopes===1&&coordinated.modelCalls===0,'Maintenance was mistaken for generation')
 assert(JSON.stringify(coordinated.state)===JSON.stringify(standalone.state),'Owner-held export changed the checked Context snapshot')
 stage='actual-running-guard';const started=await request({action:'startBusy',sessionId});busy=true
 assert(started.ok&&started.status==='running'&&started.modelCalls===1,'Fixture did not start real native generation')
 const rejected=await request({action:'export',sessionId});assert(!rejected.ok&&rejected.error.code==='EXPORT_CHANGED','Actual generating Agent export was not rejected')
 const released=await request({action:'releaseBusy',sessionId});busy=false;assert(released.ok&&released.status==='idle','Native generation did not finish')
 const after=await request({action:'export',sessionId});assert(after.ok&&after.modelCalls===1,'Export after generation failed or replayed work')
 const row=after.state.payload.sessions[0].state
 assert(row.settings.recentTurns===1&&row.settings.maxChars===9999&&row.authorNote.text==='Export lock owner note','Owner state lost in real export')
 result={...result,passed:true,stage:'complete',sessionId,checks:{standalone:true,ownerHeldScope:true,maintenancePublicStatus:'idle',sameOwnerSnapshot:true,actualGeneratingRejected:'EXPORT_CHANGED',postGenerationExport:true,ownerStatePreserved:true},counts:{ownerMaintenanceScopes:1,modelCalls:1,writerCalls:0,restoreCalls:0},standalone,coordinated,rejected,after}
 await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,archive,sha256,hostVersion:result.hostVersion,checks:result.checks,counts:result.counts}))
}catch(error){result={...result,stage,error:redact(error.message)};await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));await writeFile(join(evidence,'host-redacted.log'),redact(logs));console.error(JSON.stringify(result));process.exitCode=1}
finally{if(busy&&request)await request({action:'releaseBusy',sessionId}).catch(()=>{});await browser?.close();await kill(host)}
