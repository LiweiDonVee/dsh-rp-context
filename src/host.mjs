import {homedir} from 'node:os'
import {join} from 'node:path'
import {ContextError,buildHistory,projectHistoryState} from './core.mjs'
import {createContextStore} from './store.mjs'
import {createPlanner} from './planner.mjs'
import {createModelCaller,resolveModelConfig} from './models.mjs'
import {projectSession,createOwnerReader,narrativeHistory} from './session.mjs'
import {createContextRoutes} from './routes.mjs'
import {transferSessionIds,validateTransferState,canonicalContextState} from './transfer.mjs'
import {captureStoryHistory,ownerNarratives,hasNarrativeRevisions,effectiveHistoryUnavailable} from './history-projection.mjs'

export const name='rp-context'
export const inject=['connection','typertGateway','agents','llm']
const clone=value=>structuredClone(value)
const publicState=({historyProjection:_basis,historyRefs:_refs,ownerRepresentationIds:_ownerIds,summaryRefs:_summaryRefs,summaryProjectionKeys:_cacheBasis,...state})=>state
const metadata=record=>({id:record.id,turn:record.turn,mode:record.mode,source:record.source,...record.summary?{summary:record.summary}:{}})
const participant={id:'rp-context',nodes:[{id:'prepare',label:'RP 上下文与数据库选材',kind:'model',control:'route'},{id:'summarize',label:'RP 历史摘要',kind:'model',control:'route'}],edges:[{id:'prepared',from:'prepare',to:'host.end',label:'材料已冻结'}]}

/** Native source projection and isolated GM preparation; host Agent requests remain immutable. */
export async function createContextHost(ctx,options={}){
  const store=options.store??await createContextStore({directory:options.directory??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'app-data','rp-context')})
  const readOwner=createOwnerReader(ctx),callModel=options.callModel??createModelCaller(ctx),subscribers=new Map(),operations=new Set(),scopes=new Map(),known=new Set(),disposers=[]
  let stopped=false,inheritance=Promise.resolve()
  function notify(id,event={type:'changed'}){if(stopped)return;for(const fn of subscribers.get(id)??[]){try{fn({...event,sessionId:id})}catch{/* Observers do not own state. */}}}
  async function run(signal,work){
    if(stopped)throw new ContextError('UNAVAILABLE','Context plugin has been unloaded',503)
    const life=new AbortController();operations.add(life);const combined=signal?AbortSignal.any([signal,life.signal]):life.signal
    try{combined.throwIfAborted();return await work(combined)}finally{operations.delete(life)}
  }
  async function viewFor(input,signal){
    if(input.agent){
      if(input.agent.session.id!==input.sessionId||ctx.agents.get(input.sessionId)!==input.agent)throw new ContextError('AGENT_MISMATCH','The caller does not own this story',403)
      return projectSession({header:input.agent.session.header??{id:input.sessionId},records:input.agent.session.snapshotEvents()})
    }
    return readOwner(input.sessionId,signal)
  }
  async function ensure(view){
    if(!view.parentSession||known.has(view.sessionId))return
    const work=inheritance.then(async()=>{
      if(known.has(view.sessionId))return
      const{state:initial,activePresentationAnchors}=await noteProjection(view.parentSession,view)
      try{await store.forkSession(view.parentSession,view.sessionId,{activeAnchors:view.activeAnchors,activePresentationAnchors,expectedRevision:initial.revision})}
      catch(error){if(error.code!=='SESSION_EXISTS')throw error}
      known.add(view.sessionId)
    })
    inheritance=work.catch(()=>{});return work
  }
  async function canonicalCurrent(input,signal){
    const view=await viewFor(input,signal);await ensure(view)
    const reader=ctx.get?.('rpLastStep');let records
    if(typeof reader?.narratives==='function'){
      try{records=ownerNarratives((await reader.narratives({sessionId:input.sessionId,agent:input.agent,signal})).records)}
      catch(error){if(signal?.aborted||error?.code!==undefined||[401,403].includes(error?.status))throw error;records=narrativeHistory(view)}
    }else records=narrativeHistory(view)
    buildHistory(records)
    const projected=await noteProjection(input.sessionId,view,signal,records)
    return{view,state:projected.state,history:records,activePresentationAnchors:projected.activePresentationAnchors}
  }
  async function current(input,signal,canonical){
    const captured=canonical??await canonicalCurrent(input,signal),reader=ctx.get?.('rpLastStep')
    let history=captured.history,historyProjection
    if(typeof reader?.storyHistory==='function'){
      let response
      try{response=await reader.storyHistory({sessionId:input.sessionId,agent:input.agent,signal})}
      catch(error){if(signal?.aborted||error?.code!==undefined||[401,403].includes(error?.status))throw error;effectiveHistoryUnavailable()}
      const selected=captureStoryHistory(response);history=selected.history;historyProjection=selected.historyProjection
    }else{
      if(hasNarrativeRevisions(captured.view))effectiveHistoryUnavailable()
      const db=ctx.get?.('rpDatabase')
      if(typeof db?.factReviewProjection==='function'){
        const projection=await db.factReviewProjection({sessionId:input.sessionId,agent:input.agent,signal})
        if(projection?.schemaVersion!==1||!Array.isArray(projection.groups)||projection.groups.some(group=>!group||typeof group.roundId!=='string'||!group.roundId.trim()||group.activeReceiptId!==null&&typeof group.activeReceiptId!=='string'||group.pendingCandidateId!==null&&typeof group.pendingCandidateId!=='string'))throw new ContextError('INVALID_HISTORY','The Database fact-review projection is invalid',503)
        if(projection.groups.some(group=>group.activeReceiptId!==null||group.pendingCandidateId!==null))effectiveHistoryUnavailable()
      }
    }
    const state=projectHistoryState(history,captured.state,historyProjection)
    history=history.map(record=>({...record,...Object.hasOwn(state.summaries,record.id)?{summary:state.summaries[record.id]}:{}}))
    return{...captured,state,history,...historyProjection?{historyProjection}:{}}
  }
  function baseFor(input,view){
    if(input.baseModel)return resolveModelConfig(clone(input.baseModel))
    const agent=input.agent??ctx.agents.get(input.sessionId),header=agent?.session.requestHeader?.()
    const next=view.projections?.values?.modelSelection?.next??view.projections?.values?.modelSelection?.lastUsed
    const value=next??header?.config??ctx.get?.('agentDefaultModel')?.currentSelection?.()??agent?.options
    return resolveModelConfig(value??{})
  }
  async function routesFor(id){
    const loop=ctx.get?.('loopStudio');if(!loop)return{}
    return Object.fromEntries(await Promise.all(['prepare','summarize'].map(async stage=>[stage,clone(await loop.resolveRoute({sessionId:id,nodeId:`rp-context.${stage}`})??{})])))
  }
  async function invoke(input){
    const loop=ctx.get?.('loopStudio'),started=Date.now()
    try{loop?.recordTrace({sessionId:input.sessionId,nodeId:input.stageId,...input.config,status:'running'})}catch{/* Optional trace only. */}
    try{
      const value=await callModel(input)
      try{loop?.recordTrace({sessionId:input.sessionId,nodeId:input.stageId,...value.config,status:'completed',durationMs:Date.now()-started,tokens:value.usage})}catch{/* Optional trace only. */}
      return value
    }catch(error){try{loop?.recordTrace({sessionId:input.sessionId,nodeId:input.stageId,...input.config,status:input.signal?.aborted?'cancelled':'failed'})}catch{/* Optional trace only. */}throw error}
  }
  async function idleSessions(ids,work,code='EXPORT_CHANGED'){
    async function take(index){
      if(index===ids.length)return work()
      const agent=ctx.agents.get(ids[index])
      if(agent?.status&&agent.status!=='idle')throw new ContextError(code,'Context transfer requires idle canonical sessions',409)
      return typeof agent?.runMaintenance==='function'?agent.runMaintenance(()=>take(index+1)):take(index+1)
    }
    return take(0)
  }
  function exportIdleSessions(ids,previous){
    return ids.map((id,index)=>{
      const agent=ctx.agents.get(id),session=agent?.session
      if(agent?.status&&agent.status!=='idle'||previous&&(agent!==previous[index].agent||session!==previous[index].session))throw new ContextError('EXPORT_CHANGED','Context export requires unchanged idle canonical sessions',409)
      return{agent,session}
    })
  }
  async function noteEvidence(view,claimId,claim,signal,restore=false){
    const invalid=()=>{throw new ContextError(restore?'RESTORE_PAYLOAD_INVALID':'PRESENTATION_NOT_ACCEPTED','Author-note consumption requires one canonical finishing presentation with matching frozen claim',409)}
    const history=narrativeHistory(view,{includeInactive:true}),finishing=[...new Set(history.filter(record=>record.anchor===claim.outcomeAnchor).map(record=>record.source.presentationId))]
    if(!finishing.length)invalid()
    const last=ctx.get?.('rpLastStep'),missing=()=>{throw new ContextError(restore?'RESTORE_REQUIREMENT_MISSING':'PRESENTATION_NOT_ACCEPTED','LastStep frozen material is required before validating consumed author notes',409)}
    if(typeof last?.material!=='function')missing()
    const matches=[]
    for(const presentationId of finishing){
      let material
      try{material=await last.material({sessionId:view.sessionId,presentationId,signal})}catch(error){if(signal?.aborted)throw error;if([401,403].includes(error.status))invalid();missing()}
      const proof=material?.contextPreparation?.authorNote
      if(material?.presentationId===presentationId&&proof?.id===claim.note.id&&proof?.version===claim.note.version&&proof?.claimId===claimId)matches.push(presentationId)
    }
    if(matches.length!==1||claim.outcomePresentationId!==undefined&&claim.outcomePresentationId!==matches[0])invalid()
    return{presentationId:matches[0],active:narrativeHistory(view).some(record=>record.source.presentationId===matches[0])}
  }
  async function noteProjection(sessionId,view,signal,records=narrativeHistory(view)){
    let activePresentationAnchors=records.map(record=>record.anchor)
    let state=await store.view(sessionId,{activeAnchors:view.activeAnchors,activePresentationAnchors})
    if(state.authorNote?.status==='consumed'){
      const claimId=state.authorNote.claimedBy,claims=await store.authorNoteClaims(sessionId),claim=claims[claimId]
      const history=narrativeHistory(view,{includeInactive:true}),finishing=[...new Set(history.filter(record=>record.anchor===claim.outcomeAnchor).map(record=>record.source.presentationId))]
      let presentationId=claim.outcomePresentationId
      if(presentationId===undefined){
        if(typeof ctx.get?.('rpLastStep')?.material==='function'){
          let evidence
          try{evidence=await noteEvidence(view,claimId,claim,signal)}catch(error){if(signal?.aborted)throw error;/* Legacy local bookkeeping stays unverified until its optional proof is available. */}
          if(evidence){
            await store.cacheAuthorNoteOutcome(sessionId,{claimId,noteId:claim.note.id,version:claim.note.version,outcomeAnchor:claim.outcomeAnchor,presentationId:evidence.presentationId})
            state=await store.view(sessionId,{activeAnchors:view.activeAnchors,activePresentationAnchors})
            presentationId=(await store.authorNoteClaims(sessionId))[claimId]?.outcomePresentationId??evidence.presentationId
          }
        }
        if(presentationId===undefined&&finishing.length===1)presentationId=finishing[0]
        if(presentationId===undefined&&finishing.length>1)return{state,activePresentationAnchors}
      }
      const active=presentationId!==undefined&&narrativeHistory(view).some(record=>record.anchor===claim.outcomeAnchor&&record.source.presentationId===presentationId)
      if(!active){activePresentationAnchors=activePresentationAnchors.filter(anchor=>anchor!==claim.outcomeAnchor);state=await store.view(sessionId,{activeAnchors:view.activeAnchors,activePresentationAnchors})}
    }
    return{state,activePresentationAnchors}
  }
  async function restoredNoteEvidence(state,view,signal){
    for(const[claimId,claim]of Object.entries(state.noteClaims??{}))if(claim.status==='consumed'){const evidence=await noteEvidence(view,claimId,claim,signal,true);claim.outcomePresentationId=evidence.presentationId}
  }
  const service={
    contentRevision:(input={})=>run(input.signal,()=>store.contentRevision()),
    exportState:input=>run(input.signal,async signal=>{
      const ids=transferSessionIds(input.sessionIds),live=exportIdleSessions(ids)
      const views=await Promise.all(ids.map(id=>readOwner(id,signal))),byId=new Map(views.map(view=>[view.sessionId,view])),inherited=new Set()
      async function inherit(view){if(inherited.has(view.sessionId))return;const parent=byId.get(view.parentSession);if(parent)await inherit(parent);await ensure(view);inherited.add(view.sessionId)}
      for(const view of views)await inherit(view)
      const state=await store.exportState(ids)
      for(const item of state.payload.sessions)item.state=canonicalContextState(item.state,views.find(view=>view.sessionId===item.sessionId),{prune:true})
      const after=await Promise.all(ids.map(id=>readOwner(id,signal)))
      const revision=(await store.contentRevision()).revision
      exportIdleSessions(ids,live)
      if(revision!==state.revision||views.some((view,index)=>JSON.stringify(view.events)!==JSON.stringify(after[index].events)))throw new ContextError('EXPORT_CHANGED','Context or canonical sessions changed during export; retry explicitly',409)
      return validateTransferState(state,ids)
    }),
    preflightRestore:input=>run(input.signal,()=>store.preflightRestore(input.sessionIds,input.state)),
    restoreState:input=>run(input.signal,async signal=>{
      const result=await store.restoreState({...input,signal,validateSources:(state,ids)=>idleSessions(ids,async()=>{
        for(const item of state.payload.sessions){
          let view
          try{view=await readOwner(item.sessionId,signal)}catch(error){if(signal.aborted)throw error;throw new ContextError('RESTORE_REQUIREMENT_MISSING','Import and validate the exact canonical session before restoring Context',409)}
          canonicalContextState(item.state,view)
          await restoredNoteEvidence(item.state,view,signal)
        }
      },'RESTORE_REQUIREMENT_MISSING')})
      for(const id of result.restoredSessionIds){known.add(id);notify(id)}
      return result
    }),
    state:input=>run(input.signal,async signal=>{
      const canonical=await canonicalCurrent(input,signal)
      let projected
      try{projected=await current(input,signal,canonical)}catch(error){
        if(error?.code!=='EFFECTIVE_HISTORY_UNAVAILABLE')throw error
        return{...publicState(canonical.state),representations:{},summaries:{},unresolved:[],history:[],historyError:{code:error.code,message:error.message},scope:'preparation-and-writer'}
      }
      const{state,history}=projected,representations=Object.fromEntries(Object.entries(state.representations).filter(([id])=>history.some(record=>record.id===id)))
      return{...publicState(state),representations,history:buildHistory(history,{recentTurns:state.settings.recentTurns,representations}),scope:'preparation-and-writer'}
    }),
    configure:input=>run(input.signal,async signal=>{await ensure(await viewFor(input,signal));const result=await store.configure(input.sessionId,input);notify(input.sessionId);return publicState(result)}),
    authorNote:input=>run(input.signal,async signal=>(await canonicalCurrent(input,signal)).state.authorNote??null),
    setAuthorNote:input=>run(input.signal,async signal=>{await ensure(await viewFor(input,signal));const result=await store.setAuthorNote(input.sessionId,input);notify(input.sessionId);return result}),
    presentationOutcome:input=>run(input.signal,async signal=>{
      const{history,view}=await canonicalCurrent(input,signal)
      const accepted=history.find(record=>record.source.presentationId===input.presentationId)
      if(input.status==='accepted'&&!accepted)throw new ContextError('PRESENTATION_NOT_ACCEPTED','Only an active canonical accepted presentation can consume its author note',409)
      if(input.status==='accepted'){
        const claimId=input.claimId??input.presentationId,claim=await store.authorNoteClaim(input.sessionId,claimId)
        if(claim){
          const evidence=await noteEvidence(view,claimId,{note:claim,outcomeAnchor:accepted.anchor},signal)
          if(!evidence.active||evidence.presentationId!==input.presentationId)throw new ContextError('PRESENTATION_NOT_ACCEPTED','Accepted author-note finishing lineage is not active and unambiguous',409)
        }
      }
      const result=await store.presentationOutcome(input.sessionId,{...input,anchor:accepted?.anchor});notify(input.sessionId);return result
    }),
    material:input=>run(input.signal,async signal=>{
      await viewFor(input,signal)
      const last=ctx.get?.('rpLastStep')
      if(typeof last?.material!=='function')throw new ContextError('MATERIAL_UNAVAILABLE','The presentation material service is unavailable',503)
      return clone(await last.material({sessionId:input.sessionId,presentationId:input.presentationId,signal}))
    }),
    catalog:input=>run(input.signal,async signal=>{const{state,history}=await current(input,signal);return{revision:state.revision,settings:state.settings,history:buildHistory(history,{recentTurns:state.settings.recentTurns,representations:Object.fromEntries(Object.entries(state.representations).filter(([id])=>history.some(record=>record.id===id)))}).map(metadata),unresolved:state.unresolved}}),
    read:input=>run(input.signal,async signal=>{
      if(!Array.isArray(input.historyIds)||input.historyIds.some(id=>typeof id!=='string'))throw new ContextError('INVALID_REFERENCE','Narrative IDs must be strings')
      const{state,history}=await current(input,signal)
      return{revision:state.revision,records:[...new Set(input.historyIds)].map(id=>{const record=history.find(record=>record.id===id);if(!record)throw new ContextError('HISTORY_NOT_FOUND','Narrative is not active in this branch',404);return record})}
    }),
    search:input=>run(input.signal,async signal=>{const{state,history}=await current(input,signal);if(typeof input.query!=='string')throw new ContextError('INVALID_QUERY','Search requires text');const words=input.query.normalize('NFKC').toLocaleLowerCase().split(/\s+/u).filter(Boolean);return{revision:state.revision,matches:history.map(record=>({...metadata({...record,mode:'index'}),score:words.reduce((count,word)=>count+Number([record.action,record.text,record.summary??''].join('\n').toLocaleLowerCase().includes(word)),0)})).filter(record=>record.score>0).sort((a,b)=>b.score-a.score).slice(0,20)}}),
    represent:input=>run(input.signal,async signal=>{
      const{state,history,view,historyProjection}=await current(input,signal)
      if(!view.currentAnchor)throw new ContextError('ANCHOR_REQUIRED','History edits require a current story turn',409)
      if(!history.some(record=>record.id===input.historyId))throw new ContextError('HISTORY_NOT_FOUND','Narrative is not active in this branch',404)
      const representations={...state.representations,[input.historyId]:{mode:input.mode,...input.summary!==undefined?{summary:input.summary}:{}}}
      const filtered=Object.fromEntries(Object.entries(representations).filter(([id])=>history.some(record=>record.id===id)))
      const projected=buildHistory(history,{recentTurns:state.settings.recentTurns,representations:filtered})
      if(projected.find(record=>record.id===input.historyId)?.needsSummary)throw new ContextError('MISSING_SUMMARY','Generate an actual summary before folding this narrative',409)
      const result=await store.savePlan(input.sessionId,{representations:filtered,unresolved:state.unresolved,historyProjection,historyRefs:history.map(record=>record.source),ownerRepresentationIds:[...new Set([...(state.ownerRepresentationIds??[]),input.historyId])],anchor:view.currentAnchor,expectedRevision:input.expectedRevision});notify(input.sessionId);return publicState(result)
    }),
    prepare:input=>run(input.signal,async signal=>{
      const canonical=await canonicalCurrent(input,signal);if(!canonical.state.settings.enabled)return null
      const{history,view,activePresentationAnchors,historyProjection}=await current(input,signal,canonical)
      if(!view.currentAnchor)throw new ContextError('ANCHOR_REQUIRED','Preparation requires the current Agent turn',409)
      const db=ctx.get?.('rpDatabase');let database
      if(db?.apiVersion===2&&typeof db.materialAccess!=='function')throw new ContextError('DATABASE_CAPABILITY_UNAVAILABLE','Database v2 materialAccess is required for qualified material preparation',503)
      if(db){await db.ensureAgent?.(input.agent??ctx.agents.get(input.sessionId));if(db.hasBinding(input.sessionId))database=db.apiVersion===2?{...await db.materialAccess({sessionId:input.sessionId,agent:input.agent,signal}),version:2}:{
        snapshot:()=>db.effective({sessionId:input.sessionId,agent:input.agent,signal}),
        search:args=>db.search({...args,sessionId:input.sessionId,agent:input.agent,signal}),
        apply:db.applyToSnapshot,select:db.selectFromSnapshot,
        commit:args=>db.patch({...args,sessionId:input.sessionId,agent:input.agent,signal}),
      }}
      const planner=createPlanner({store,callModel:invoke,resolveModels:({sessionId})=>routesFor(sessionId),publish:event=>{if(event.status==='prepared')notify(input.sessionId);notify(input.sessionId,{...event,type:'stage'});try{ctx.emit('rp-context/stage',{...event,sessionId:input.sessionId})}catch{/* Optional UI observer. */}}})
      const result=await planner.prepare({sessionId:input.sessionId,anchor:view.currentAnchor,activeAnchors:view.activeAnchors,activePresentationAnchors,historyProjection,packet:clone(input.packet),presentationId:input.presentationId,factReceiptId:input.factReceiptId,story:clone(input.story),history,database,baseModel:baseFor(input,view),signal})
      notify(input.sessionId);return result
    }),
    authorize:(id,signal)=>run(signal,combined=>readOwner(id,combined)),
    subscribe(id,fn){const set=subscribers.get(id)??new Set();set.add(fn);subscribers.set(id,set);return()=>{set.delete(fn);if(!set.size)subscribers.delete(id)}},
    async close(){if(stopped)return;stopped=true;for(const life of operations)life.abort();for(const record of scopes.values())for(const dispose of record)dispose();for(const dispose of disposers)await dispose();scopes.clear();subscribers.clear()},
  }
  const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
  const definitions=[
    {name:'rp_context_status',method:'catalog',description:'Inspect current-branch narrative references, representations and unresolved matters.',parameters:object({})},
    {name:'rp_context_read',method:'read',description:'Expand exact original narratives in the active branch without changing or deleting history.',parameters:object({historyIds:{type:'array',items:{type:'string'}}},['historyIds'])},
    {name:'rp_context_search',method:'search',description:'Search active narrative text and summaries; excluded branches and failed drafts are unavailable.',parameters:object({query:{type:'string'}},['query'])},
    {name:'rp_context_fold',method:'represent',description:'Choose full, actual summary, or index for an active narrative. Original text is retained.',parameters:object({historyId:{type:'string'},mode:{enum:['full','summary','index']},summary:{type:'string'},expectedRevision:{type:'integer'}},['historyId','mode','expectedRevision'])},
  ]
  async function attach(agent){
    if(stopped||scopes.has(agent))return
    const owned=[];scopes.set(agent,owned)
    await ensure(projectSession({header:agent.session.header??{id:agent.session.id},records:agent.session.snapshotEvents()}));if(stopped||scopes.get(agent)!==owned)return
    for(const definition of definitions)owned.push(agent.ctx.tools.register({...definition,output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>{
      if(!args||typeof args!=='object'||Object.keys(args).some(key=>!Object.hasOwn(definition.parameters.properties,key)))throw new ContextError('INVALID_OPERATION','Unexpected context arguments')
      return service[definition.method]({...args,sessionId:exec.agent.session.id,agent:exec.agent,signal:exec.signal})
    }}))
  }
  disposers.push(ctx.on('agent/created',({agent})=>attach(agent)))
  disposers.push(ctx.on('agent/disposed',({agent})=>{for(const dispose of scopes.get(agent)??[])dispose();scopes.delete(agent)}))
  for(const agent of ctx.agents.list())await attach(agent)
  disposers.push(ctx.on('session/event',(session,event)=>{if(['user/message','assistant/message','tool/result','turn/end'].includes(event.type))notify(session.id)}))
  if(typeof ctx.inject==='function')ctx.inject(['loopStudio'],child=>{const mount=()=>{const loop=child.get?.('loopStudio')??child.loopStudio;return loop.registerParticipant(clone(participant))};if(child.effect)child.effect(mount,'RP context Loop participant');else disposers.push(mount())})
  else{const loop=ctx.get?.('loopStudio');if(loop)disposers.push(loop.registerParticipant(clone(participant)))}
  return service
}

export async function apply(ctx,config={}){
  const service=await createContextHost(ctx,config),routes=createContextRoutes(service);ctx.provide('rpContext',service)
  const unregister=[ctx.connection.fetch.register({path:'/api/rp-context/request',methods:['POST'],requestBody:'buffered',fetch:request=>routes.request(request)}),ctx.connection.fetch.register({path:'/api/rp-context/events',methods:['GET'],requestBody:'buffered',fetch:request=>routes.events(request)})]
  ctx.effect(()=>async()=>{routes.close();await service.close();for(const dispose of unregister)dispose()},'RP context runtime')
}
