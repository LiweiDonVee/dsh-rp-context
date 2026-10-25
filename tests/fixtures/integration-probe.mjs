// Native integration driver. Real installed Database/Context/LastStep own all product work.
// The only extra tool is an explicitly synthetic allowed working-entry update; this is not rpGM.
export const name = 'context-integration-probe'
export const inject = ['llm','agents','tools','connection','typertGateway','sessionQuery']

const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const key = (sourceKey, entryId) => JSON.stringify([sourceKey,entryId])
const K = { world:key('world','same'), actor:key('actor','same'), outside:key('world','outside'), hidden:key('world','disabled'), facts:key('@session','gm.facts') }
const check = (value,message) => { if (!value) throw Error(message) }
const entry = (id,content,extra={}) => ({id,title:id,content,keywords:[],tags:[],notes:'',readOnly:false,mode:'auto',version:1,...extra})
async function* textChunks(text) {
  yield {type:'text-delta',index:0,text}
  yield {type:'usage',usage:{inputTokens:11,outputTokens:7}}
  yield {type:'finish',reason:{kind:'stop'}}
}
async function* toolChunks(name,args) {
  const id='integration-reused-provider-id'
  yield {type:'block-start',index:0,blockType:'tool-call'}
  yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)}
  yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}}
  yield {type:'finish',reason:{kind:'tool-calls'}}
}

export function apply(ctx) {
  const calls=[],facts=[],plans=new Map(),writers=new Map(),runs=new Map(),stages=[]
  const service = name => { const value=ctx.get(name);if(!value)throw Error('Missing real service '+name);return value }
  const invoke = (method,request,signal) => ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
  const onStage = value => stages.push(Object.fromEntries(['sessionId','id','presentationId','stageId','status','code','step'].filter(name=>value[name]!==undefined).map(name=>[name,value[name]])))
  ctx.on('rp-context/stage',onStage);ctx.on('rp-last-step/presentation',onStage)

  ctx.tools.register({name:'context_fixture_fact',description:'Synthetic integration action: update an allowed story-local counter, never GM-owned facts.',parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(_args,exec)=>{
      const db=service('rpDatabase'),snapshot=await db.effectiveV2({sessionId:exec.agent.session.id,agent:exec.agent,signal:exec.signal})
      const row=snapshot.entries.find(item=>item.ref.sourceKey==='@session'&&item.id==='turn-counter'),count=Number(row.content)+1
      const committed=await db.patchV2({sessionId:exec.agent.session.id,agent:exec.agent,expectedRevision:snapshot.revision,operations:[{op:'update',ref:row.ref,patch:{content:String(count)}}],signal:exec.signal})
      facts.push({sessionId:exec.agent.session.id,count,revision:committed.revision})
      return {fixtureFact:true,count,summary:'Rain is visible in the courtyard.'}
    }})

  const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,value)=>value,
    listModels:async provider=>[{provider,id:'main',name:'Integration local'}],resolveModel:async(provider,id)=>({provider,id,name:id}),
    async prepareCall(provider,id){return {model:await this.resolveModel(provider,id),stream:options=>this.stream(options)}},
    async* stream(options){
      const system=options.system??'',body=options.messages.map(textOf).join('\n')
      if(system.includes('RP_CONTEXT_SUMMARIZE')){
        const input=JSON.parse(body);calls.push({stage:'summarize',ids:input.history.map(row=>row.id),sources:input.history.map(row=>row.source)})
        yield*textChunks(JSON.stringify({summaries:input.history.map(row=>({id:row.id,summary:'Confirmed summary: '+row.text}))}));return
      }
      if(system.includes('RP_CONTEXT_PREPARE')){
        const input=JSON.parse(body),runId=input.packet.variables.fixtureRunId,step=plans.get(runId)??0;plans.set(runId,step+1)
        const row={stage:'prepare',runId,step:step+1,diagnostics:input.diagnostics,initialKeys:input.candidates.map(item=>item.key),readRefs:input.readEntries.map(item=>item.ref),authorNote:input.authorNote}
        calls.push(row)
        check(input.database.binding.schemaVersion===2,'Context did not consume real v2 binding')
        check(!body.includes('NO_PROVIDER_OR_WRITER_DISABLED_SENTINEL'),'Disabled entry body reached planner')
        let reply
        if(step===0){
          check(!input.candidates.some(item=>item.key===K.outside),'Outside target was already an initial candidate')
          reply={databaseOperations:[{op:'update',id:K.world,patch:{content:'SHOULD_NOT_STAGE'}},{op:'update',id:K.facts,patch:{content:'FORBIDDEN FACT EDIT'}}],commit:true}
        }else if(step===1){
          check(input.diagnostics[0]?.code==='FACT_OWNER_REQUIRED','Real material executor did not protect facts')
          check(!input.candidates.some(item=>item.excerpt.includes('SHOULD_NOT_STAGE')),'Mixed rejected batch partially staged')
          reply={selectedEntries:[K.hidden],commit:true}
        }else if(step===2){
          check(['NOT_FOUND','DISABLED'].includes(input.diagnostics[0]?.code),'Disabled guessed key was not rejected')
          reply={search:['buried-observatory'],commit:false}
        }else if(step===3){
          check(input.searchResults.some(result=>result.candidates.some(item=>item.key===K.outside)),'Full database search missed outside candidate')
          reply={readEntries:[K.world,K.actor,K.outside],commit:false}
        }else if(step===4){
          const duplicate=input.readEntries.filter(item=>item.id==='same')
          check(duplicate.length===2&&new Set(duplicate.map(item=>item.ref.sourceKey)).size===2,'Qualified exact reads collided')
          check(input.readEntries.some(item=>item.ref.entryId==='outside'&&item.content==='SECRET OBSERVATORY FACT'),'Outside exact body missing')
          reply={databaseOperations:[{op:'update',id:K.world,patch:{content:'SELECTED WORKING TEXT '+runId}},{op:'note',id:K.world,text:'Integration material guidance; not a happened fact.'}],selectedEntries:[K.world,K.outside],notes:'Keep rain visible.',commit:true}
        }else throw Error('Preparation unexpectedly repeated for frozen run '+runId)
        yield*textChunks(JSON.stringify(reply));return
      }
      if(system.includes('RP_LAST_STEP_ASSEMBLE')){
        const input=JSON.parse(body),variables=input.packet.variables
        calls.push({stage:'assemble',runId:variables.fixtureRunId,step:input.step,contextChars:input.context?.chars})
        check(input.context?.entries.some(item=>item.ref.sourceKey==='actor'&&item.id==='same'),'Required actor entry missing at assembly')
        const reply=variables.fixtureMode==='assembly-fail'?{commit:false}:input.feedback.entries.length?{commit:true}:{read:['narration'],commit:false}
        yield*textChunks(JSON.stringify(reply));return
      }
      if(system.includes('RP_LAST_STEP_RENDER')){
        const input=JSON.parse(body),variables=input.packet.variables,attempt=(writers.get(variables.fixtureRunId)??0)+1;writers.set(variables.fixtureRunId,attempt)
        calls.push({stage:'writer',runId:variables.fixtureRunId,attempt,input})
        check(!options.tools?.length,'Writer received tools')
        check(input.context.entries.filter(item=>item.id==='same').length===2,'Writer did not receive both source-qualified same IDs')
        check(!body.includes('NO_PROVIDER_OR_WRITER_DISABLED_SENTINEL'),'Disabled body reached writer')
        check(!body.includes('SHOULD_NOT_STAGE'),'Rejected working edit reached writer')
        if(variables.fixtureMode==='writer-fail'&&attempt===1)throw Error('Explicit local writer failure after compiled snapshot')
        yield*textChunks('Accepted prose '+variables.fixtureRunId+': rain falls across the courtyard.');return
      }
      const agent=ctx.agents.currentInitiator(),run=agent&&runs.get(agent.session.id)
      check(run,'Native main request has no integration run')
      const human=options.messages.findLastIndex(message=>message.role==='user'&&message.source?.kind==='user'),tail=options.messages.slice(human+1)
      const results=tail.filter(message=>message.role==='tool')
      calls.push({stage:'main',sessionId:agent.session.id,runId:run.runId,mode:run.mode,tools:options.tools?.map(tool=>tool.name)??[],toolTexts:options.messages.filter(message=>message.role==='tool').map(textOf)})
      if(run.mode==='retry'){
        if(results.length){yield*textChunks('Fixture retry was rejected; owner review required.');return}
        yield*toolChunks('rp_present',{rewriteOf:run.presentationId});return
      }
      if(!results.some(message=>textOf(message).includes('"fixtureFact":true'))){yield*toolChunks('context_fixture_fact',{});return}
      if(results.length>1){yield*textChunks('Fixture presentation failed; wait for an explicit owner recovery action.');return}
      yield*toolChunks('rp_present',{packet:{playerAction:run.action,sceneInstruction:'Observe the rainy courtyard.',resolvedChanges:['Rain falls in the courtyard.'],visibleConsequences:['Wet stones reflect the lamp.'],openHooks:['The observatory remains unexplored.'],proseConstraints:['Preserve player control.'],publicFactRefs:[],variables:{fixtureSessionId:agent.session.id,fixtureRunId:run.runId,fixtureMode:run.mode}}})
    }}
  ctx.llm.registerAdapter(['context-integration-local'],adapter)

  async function snapshot(sessionId,signal){
    const observed=await ctx.sessionQuery.observeSession(sessionId)
    try{
      const database=await service('rpDatabase').effectiveV2({sessionId,signal}),last=await service('rpLastStep').state(sessionId,signal),context=await service('rpContext').state({sessionId,signal})
      const materials=[]
      for(const row of last.presentations)materials.push(await service('rpLastStep').material({sessionId,presentationId:row.id,signal}))
      return {sessionId,events:observed.events,messages:ctx.agents.get(sessionId)?.session.deriveMessages()??null,database,last,context,materials,calls,facts,stages}
    }finally{observed[Symbol.dispose]()}
  }
  async function setup(signal){
    const db=service('rpDatabase'),last=service('rpLastStep'),context=service('rpContext')
    check(db.apiVersion===2&&typeof db.materialAccess==='function','Real Database v2 capability missing')
    const {sessionId}=await invoke('create',{agentPreset:'context-integration-story'},signal)
    const rawWorld='\uFEFF'+JSON.stringify({name:'Synthetic world',entries:[entry('same','WORLD ORIGINAL',{keywords:['courtyard']}),...Array.from({length:26},(_,i)=>entry('filler-'+String(i).padStart(2,'0'),'COURTYARD CANON '+i,{keywords:['courtyard']})),entry('outside','SECRET OBSERVATORY FACT',{keywords:['buried-observatory']}),entry('required','REQUIRED WORLD BELL',{mode:'required',readOnly:true}),entry('disabled','NO_PROVIDER_OR_WRITER_DISABLED_SENTINEL',{mode:'disabled'})]},null,2).replaceAll('\n','\r\n')
    const rawActor=JSON.stringify({name:'Synthetic actors',entries:[entry('same','ACTOR ORIGINAL',{mode:'required'}),entry('locked','LOCKED REFERENCE',{readOnly:true})]})
    let revision=(await db.state()).revision
    const world=await db.import({rawText:rawWorld,name:'Integration world',expectedRevision:revision,signal});revision=world.revision
    const actor=await db.import({rawText:rawActor,name:'Integration actor',expectedRevision:revision,signal});revision=actor.revision
    const sources=[{key:'world',databaseId:world.databaseId,version:world.version},{key:'actor',databaseId:actor.databaseId,version:actor.version}]
    const bound=await db.bindSources({sessionId,sources,expectedRevision:revision,resetOverlay:false,signal})
    const seeds=[entry('gm.scene',JSON.stringify({schemaVersion:1,title:'Courtyard',location:'Courtyard',presentActorIds:['archivist']}),{mode:'required'}),entry('gm.facts',JSON.stringify({schemaVersion:1,items:[{id:'rain',text:'Rain falls in the courtyard.'}]}),{mode:'required'}),entry('turn-counter','0')]
    await db.initializeStoryState({sessionId,launchId:'integration-owner-seed-'+sessionId,entries:seeds,factEntryRefs:[{sourceKey:'@session',entryId:'gm.scene'},{sourceKey:'@session',entryId:'gm.facts'}],expectedRevision:bound.revision,signal})
    const profile=await last.ensureBuiltinProfile({key:'context.integration.profile.v1',profile:{name:'Synthetic integration prose',entries:[{id:'narration',name:'Narration',content:'Use concise third-person prose. Preserve resolved public facts.',role:'system',phase:'render',order:0,enabled:true,required:true,locked:true}]},signal})
    await last.bindSession({sessionId,...profile,expectedRevision:(await last.state(sessionId,signal)).revision},signal)
    const initial=await context.state({sessionId,signal});await context.configure({sessionId,settings:{recentTurns:1},expectedRevision:initial.revision,signal})
    return {sessionId,sources,world,actor,profile,rawWorld,rawActor,protectedFacts:seeds.filter(row=>row.id.startsWith('gm.')).map(({id,content})=>({id,content})),capabilities:{databaseVersion:db.apiVersion,narratives:typeof last.narratives==='function',material:typeof last.material==='function',productionAdoptDispatchTested:false,productionGmTested:false}}
  }

  ctx.connection.fetch.register({path:'/api/context-integration',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try{
      const input=await request.json(),signal=request.signal
      if(input.action==='setup')return Response.json(await setup(signal))
      if(input.action==='run'){
        const agent=ctx.agents.get(input.sessionId);check(agent,'Live integration Agent required')
        runs.set(input.sessionId,{runId:input.runId,mode:input.mode??'success',presentationId:input.presentationId,action:input.text??'Check courtyard.'})
        await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:input.text??'Check courtyard.'}]},signal);await agent.whenIdle()
        return Response.json(await snapshot(input.sessionId,signal))
      }
      if(input.action==='snapshot')return Response.json(await snapshot(input.sessionId,signal))
      if(input.action==='note'){const context=service('rpContext'),state=await context.state({sessionId:input.sessionId,signal});return Response.json(await context.setAuthorNote({sessionId:input.sessionId,text:input.text,expectedRevision:state.revision,signal}))}
      if(input.action==='editAfterFreeze'){
        const db=service('rpDatabase'),before=await db.effectiveV2({sessionId:input.sessionId,signal})
        return Response.json(await db.patchV2({sessionId:input.sessionId,expectedRevision:before.revision,operations:[{op:'update',ref:{sourceKey:'world',entryId:'same'},patch:{content:'OVERLAY AFTER FREEZE'}}],signal}))
      }
      if(input.action==='sources')return Response.json({world:await service('rpDatabase').source({sourceId:input.worldSourceId,signal}),actor:await service('rpDatabase').source({sourceId:input.actorSourceId,signal})})
      if(input.action==='contextExport')return Response.json(await service('rpContext').exportState({sessionIds:[input.sessionId],signal}))
      if(input.action==='fork')return Response.json(await invoke('fork',{sessionId:input.sessionId,atSeq:input.atSeq},signal))
      return Response.json({error:{code:'INVALID_FIXTURE_ACTION',message:'Unknown integration operation'}},{status:400})
    }catch(error){return Response.json({error:{code:error.code??'INTEGRATION_FIXTURE_ERROR',message:error.message,stack:error.stack}},{status:500})}
  }})
}
