import {spawn,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'

const packageName="dsh-rp-context",root=process.cwd(),home=resolve('.runtime/'+packageName+'-smoke-'+Date.now()),evidence=resolve('.runtime/native-evidence')
const artifact=resolve('artifacts/'+packageName+'-0.1.0.tgz')
const artifactSHA256=createHash('sha256').update(await readFile(artifact)).digest('hex')
const cli=process.env.DSH_BIN??(process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'):'dsh')
const quote=value=>process.platform==='win32'?'"'+value+'"':value
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'native-smoke-placeholder-unused'}
const redact=value=>String(value).replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]').replace(/(Bearer\s+)[\w.-]+/giu,'$1[REDACTED]')
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
await writeFile(join(home,'package.json'),JSON.stringify({name:packageName+'-smoke-home',private:true,type:'module'}))
let host,browser,page,logs='',stage='install',result={passed:false,status:'running',artifactSHA256,standalone:true,packageName},errors=[]
const save=()=>writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2))
await save()
const kill=child=>new Promise(done=>{if(!child?.pid)return done();if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>done());else{child.kill('SIGTERM');done()}})
const install=()=>new Promise((done,reject)=>{
 const child=spawn(quote(cli),['plugin','--profile','web','add',quote(artifact)],{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:'pipe'});let output=''
 const timer=setTimeout(async()=>{await kill(child);reject(Error('Package installation timed out'))},60_000)
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>output+=data)
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);if(code===0)done();else reject(Error('Package installation failed: '+redact(output.slice(-6000))))})
})
const assert=(condition,message)=>{if(!condition)throw Error(message)}
try{
 await install()
 const fixture=join(home,'native-probe.mjs');await writeFile(fixture,await readFile('tests/fixtures/native-probe.mjs'))
 const patch=join(home,'probe.patch.yml')
 await writeFile(patch,'- id: agent-default-model\n  config:\n    provider: smoke-local\n    model: main\n- insert:\n    - id: native-smoke-probe\n      name: '+JSON.stringify(fixture.replaceAll('\\','/'))+'\n    - id: native-smoke-story\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: native-smoke-story\n        name: 独立合成故事验收\n        description: 本地确定性模型，无私有资料\n        plugins: []\n')
 stage='host-start'
 host=spawn(quote(cli),['--profile','web','--patch',quote(patch),'--host','127.0.0.1','--port','0','--no-open'],{shell:process.platform==='win32',windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']})
 for(const stream of[host.stdout,host.stderr])stream.on('data',data=>logs+=data)
 let url;const deadline=Date.now()+40_000
 while(Date.now()<deadline){url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(url)break;if(host.exitCode!==null)throw Error('Native host exited');await new Promise(done=>setTimeout(done,100))}
 assert(url,'Native host startup timed out')
 stage='browser'
 browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15_000);page.on('pageerror',error=>errors.push(error.message))
 // Observe the public workspace UI service only; no loop/session state rewriting.
 await page.addInitScript(()=>{Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target);const observed=row=>load(row.id!=='@deepseek-ai/dsh-client-ui-workspace'?row:{...row,factory(require){const plugin=row.factory(require);return{...plugin,apply(ctx){window.__workspaceCtx=ctx;return plugin.apply(ctx)}}}});Object.defineProperty(target,'load',{configurable:true,get:()=>observed,set(next){load=next.bind(target)}})}})})
 await page.goto(url,{waitUntil:'networkidle'})
 const preview=page.getByRole('button',{name:'继续',exact:true});await preview.waitFor({state:'visible',timeout:2000}).catch(()=>{});if(await preview.isVisible())await preview.click()
 const request=(path,input)=>page.evaluate(async({path,input})=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(35_000)}),value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value.data??value},{path,input})
 const api=(action,input={})=>request('api/'+packageName.replace('dsh-','')+'/request',{action,...input})
 const probe=input=>request('api/native-smoke',input)
 const {sessionId}=await probe({action:'create'})
 stage='canonical-native-history'
 for(const text of ['我听门外声音。','我等待守卫反应。','我查看脚印。'])await probe({action:'run',sessionId,text})
 let state=await api('state',{sessionId})
 assert(state.history.length===3,'Three native terminal receipts did not form canonical narrative history')
 const originals=await api('read',{sessionId,historyIds:state.history.map(row=>row.id)})
 assert(originals.records.every(row=>Number.isSafeInteger(row.source.callSeq)&&row.source.resultSeq>row.source.callSeq),'Canonical source event references missing')
 await api('configure',{sessionId,settings:{recentTurns:1},expectedRevision:state.revision})
 const prepared=await probe({action:'prepare',sessionId})
 assert(!prepared.hasDatabase&&!prepared.prepared.database,'Standalone context unexpectedly loaded database')
 assert(prepared.calls.filter(row=>row.kind==='main').length===3&&prepared.receipts.length===3,'Native terminal turns were repeated')
 assert(prepared.calls.some(row=>row.kind==='summarize'&&row.ids.length===2),'Actual summaries were not generated')
 const exactRead=prepared.calls.find(row=>row.kind==='prepare'&&row.readHistory.length)?.readHistory[0]
 assert(exactRead?.text===originals.records[0].text,'Middle GM did not read exact original')
 const modes=prepared.prepared.materials.history.map(row=>row.mode)
 assert(JSON.stringify(modes)===JSON.stringify(['summary','index','full']),'Preparation did not commit three representation modes')
 const after=await api('read',{sessionId,historyIds:originals.records.map(row=>row.id)})
 assert(after.records.length===originals.records.length&&after.records.every((row,i)=>row.text===originals.records[i].text&&JSON.stringify(row.source)===JSON.stringify(originals.records[i].source)),'Preparation changed original source')
 const checks={nativeTurns:3,canonicalSources:true,standalonePreparation:true,actualSummaries:true,exactRead:true,modes,originalsRetained:true}

 stage='native-ui'
 await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),sessionId)
 await page.getByRole('button',{name:"打开主动上下文",exact:true}).click()
 const panel=page.locator("[data-rp-context-root]");await panel.waitFor({state:'visible'})
 await page.getByText('当前窗口用于中间 GM 选材与最终写作输入。DSH 主 Agent 的历史和日志仍然保留；原生与 ACP 的上下文压缩由宿主管理。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'展开原文',exact:true}).click()
 await page.getByRole('region',{name:'历史原文',exact:true}).waitFor()
 assert((await page.getByRole('region',{name:'历史原文',exact:true}).textContent()).includes(originals.records[0].text),'Native original viewer omitted exact prose')

 await page.screenshot({path:join(evidence,'native-sidebar.png')})
 const layoutMetrics=[]
 const metrics=label=>page.evaluate(({selector,label})=>{const node=document.querySelector(selector),box=node.getBoundingClientRect();return{label,viewport:innerWidth,width:Math.round(box.width),height:Math.round(box.height),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,documentWidth:document.documentElement.scrollWidth}},{selector:"[data-rp-context-root]",label})
 layoutMetrics.push(await metrics('sidebar'))
 const fullscreen=page.getByRole('button',{name:'全屏',exact:true})
 await fullscreen.click();await page.waitForTimeout(200)
 layoutMetrics.push(await metrics('fullscreen'));assert(layoutMetrics.at(-1).width>900,'Native full-screen panel did not expand')
 await page.screenshot({path:join(evidence,'native-fullscreen.png')})
 await page.setViewportSize({width:520,height:900});await page.waitForTimeout(150)
 layoutMetrics.push(await metrics('narrow'));await page.screenshot({path:join(evidence,'native-narrow.png')})
 assert(layoutMetrics.at(-1).documentWidth<=530,'Narrow native UI overflows viewport')
 await page.setViewportSize({width:1440,height:1000})
 // Native close followed by the same conversation header entry.
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 await panel.waitFor({state:'hidden'})
 await page.getByRole('button',{name:"打开主动上下文",exact:true}).click();await panel.waitFor({state:'visible'})
 await page.screenshot({path:join(evidence,'native-reopened.png')})
 assert(errors.length===0,'Browser page errors: '+JSON.stringify(errors))
 result={...result,passed:true,status:'passed',checks,layoutMetrics,pageErrors:errors};await save();console.log(JSON.stringify(result))
}catch(error){
 if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{})
 result={...result,passed:false,status:'failed',stage,error:redact(error.message),pageErrors:errors};await save()
 await writeFile(join(evidence,'host-redacted.log'),redact(logs.slice(-16000)))
 console.error(JSON.stringify(result));process.exitCode=1
}finally{await browser?.close();await kill(host)}

