import {homedir} from 'node:os'
import {join} from 'node:path'
import {ContextError,buildHistory} from './core.mjs'
import {createContextStore} from './store.mjs'
import {createPlanner} from './planner.mjs'
import {createModelCaller,resolveModelConfig} from './models.mjs'
import {projectSession,createOwnerReader,narrativeHistory} from './session.mjs'
import {createContextRoutes} from './routes.mjs'

export const name='rp-context'
export const inject=['connection','typertGateway','agents','llm']
const clone=value=>structuredClone(value)
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
      const initial=await store.view(view.parentSession,{activeAnchors:view.activeAnchors})
      try{await store.forkSession(view.parentSession,view.sessionId,{activeAnchors:view.activeAnchors,expectedRevision:initial.revision})}
      catch(error){if(error.code!=='SESSION_EXISTS')throw error}
      known.add(view.sessionId)
    })
    inheritance=work.catch(()=>{});return work
  }
  async function current(input,signal){const view=await viewFor(input,signal);await ensure(view);const state=await store.view(input.sessionId,{activeAnchors:view.activeAnchors});const history=narrativeHistory(view).map(record=>({...record,...Object.hasOwn(state.summaries,record.id)?{summary:state.summaries[record.id]}:{}}));return{view,state,history}}
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
  const service={
    state:input=>run(input.signal,async signal=>{const{state,history}=await current(input,signal);const representations=Object.fromEntries(Object.entries(state.representations).filter(([id])=>history.some(record=>record.id===id)));return{...state,representations,history:buildHistory(history,{recentTurns:state.settings.recentTurns,representations}),scope:'preparation-and-writer'}}),
    configure:input=>run(input.signal,async signal=>{await current(input,signal);const result=await store.configure(input.sessionId,input);notify(input.sessionId);return result}),
    catalog:input=>run(input.signal,async signal=>{const{state,history}=await current(input,signal);return{revision:state.revision,settings:state.settings,history:buildHistory(history,{recentTurns:state.settings.recentTurns,representations:Object.fromEntries(Object.entries(state.representations).filter(([id])=>history.some(record=>record.id===id)))}).map(metadata),unresolved:state.unresolved}}),
    read:input=>run(input.signal,async signal=>{
      if(!Array.isArray(input.historyIds)||input.historyIds.some(id=>typeof id!=='string'))throw new ContextError('INVALID_REFERENCE','Narrative IDs must be strings')
      const{state,history}=await current(input,signal)
      return{revision:state.revision,records:[...new Set(input.historyIds)].map(id=>{const record=history.find(record=>record.id===id);if(!record)throw new ContextError('HISTORY_NOT_FOUND','Narrative is not active in this branch',404);return record})}
    }),
    search:input=>run(input.signal,async signal=>{const{state,history}=await current(input,signal);if(typeof input.query!=='string')throw new ContextError('INVALID_QUERY','Search requires text');const words=input.query.normalize('NFKC').toLocaleLowerCase().split(/\s+/u).filter(Boolean);return{revision:state.revision,matches:history.map(record=>({...metadata({...record,mode:'index'}),score:words.reduce((count,word)=>count+Number([record.action,record.text,record.summary??''].join('\n').toLocaleLowerCase().includes(word)),0)})).filter(record=>record.score>0).sort((a,b)=>b.score-a.score).slice(0,20)}}),
    represent:input=>run(input.signal,async signal=>{
      const{state,history,view}=await current(input,signal)
      if(!view.currentAnchor)throw new ContextError('ANCHOR_REQUIRED','History edits require a current story turn',409)
      if(!history.some(record=>record.id===input.historyId))throw new ContextError('HISTORY_NOT_FOUND','Narrative is not active in this branch',404)
      const representations={...state.representations,[input.historyId]:{mode:input.mode,...input.summary!==undefined?{summary:input.summary}:{}}}
      const filtered=Object.fromEntries(Object.entries(representations).filter(([id])=>history.some(record=>record.id===id)))
      const projected=buildHistory(history,{recentTurns:state.settings.recentTurns,representations:filtered})
      if(projected.some(record=>record.needsSummary))throw new ContextError('MISSING_SUMMARY','Generate an actual summary before folding this narrative',409)
      const result=await store.savePlan(input.sessionId,{representations:filtered,unresolved:state.unresolved,anchor:view.currentAnchor,expectedRevision:input.expectedRevision});notify(input.sessionId);return result
    }),
    prepare:input=>run(input.signal,async signal=>{
      const{state,history,view}=await current(input,signal);if(!state.settings.enabled)return null
      if(!view.currentAnchor)throw new ContextError('ANCHOR_REQUIRED','Preparation requires the current Agent turn',409)
      const db=ctx.get?.('rpDatabase');let database
      if(db){await db.ensureAgent?.(input.agent??ctx.agents.get(input.sessionId));if(db.hasBinding(input.sessionId))database={
        snapshot:()=>db.effective({sessionId:input.sessionId,agent:input.agent,signal}),
        search:args=>db.search({...args,sessionId:input.sessionId,agent:input.agent,signal}),
        apply:db.applyToSnapshot,select:db.selectFromSnapshot,
        commit:args=>db.patch({...args,sessionId:input.sessionId,agent:input.agent,signal}),
      }}
      const planner=createPlanner({store,callModel:invoke,resolveModels:({sessionId})=>routesFor(sessionId),publish:event=>{notify(input.sessionId,{...event,type:'stage'});try{ctx.emit('rp-context/stage',{...event,sessionId:input.sessionId})}catch{/* Optional UI observer. */}}})
      const result=await planner.prepare({sessionId:input.sessionId,anchor:view.currentAnchor,activeAnchors:view.activeAnchors,packet:clone(input.packet),history,database,baseModel:baseFor(input,view),signal})
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
    await ensure(projectSession({header:agent.session.header??{id:agent.session.id},records:agent.session.snapshotEvents()}));if(stopped)return
    const owned=[];scopes.set(agent,owned)
    for(const definition of definitions)owned.push(agent.ctx.tools.register({...definition,output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>{
      if(!args||typeof args!=='object'||Object.keys(args).some(key=>!Object.hasOwn(definition.parameters.properties,key)))throw new ContextError('INVALID_OPERATION','Unexpected context arguments')
      return service[definition.method]({...args,sessionId:exec.agent.session.id,agent:exec.agent,signal:exec.signal})
    }}))
  }
  for(const agent of ctx.agents.list())await attach(agent)
  disposers.push(ctx.on('agent/created',({agent})=>attach(agent)))
  disposers.push(ctx.on('agent/disposed',({agent})=>{for(const dispose of scopes.get(agent)??[])dispose();scopes.delete(agent)}))
  disposers.push(ctx.on('session/event',(session,event)=>{if(['tool/result','turn/end'].includes(event.type))notify(session.id)}))
  if(typeof ctx.inject==='function')ctx.inject(['loopStudio'],child=>{const mount=()=>{const loop=child.get?.('loopStudio')??child.loopStudio;return loop.registerParticipant(clone(participant))};if(child.effect)child.effect(mount,'RP context Loop participant');else disposers.push(mount())})
  else{const loop=ctx.get?.('loopStudio');if(loop)disposers.push(loop.registerParticipant(clone(participant)))}
  return service
}

export async function apply(ctx,config={}){
  const service=await createContextHost(ctx,config),routes=createContextRoutes(service);ctx.provide('rpContext',service)
  const unregister=[ctx.connection.fetch.register({path:'/api/rp-context/request',methods:['POST'],requestBody:'buffered',fetch:request=>routes.request(request)}),ctx.connection.fetch.register({path:'/api/rp-context/events',methods:['GET'],requestBody:'buffered',fetch:request=>routes.events(request)})]
  ctx.effect(()=>async()=>{routes.close();await service.close();for(const dispose of unregister)dispose()},'RP context runtime')
}
