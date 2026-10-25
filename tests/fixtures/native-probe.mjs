// Local deterministic models; no paid providers, private profiles, or source imports.
export const name='native-smoke-probe'
export const inject=['llm','agents','tools','connection','typertGateway','commands','sessionQuery','sessionPersistence']
const textOf=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
async function* textChunks(text){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'usage',usage:{inputTokens:10,outputTokens:10}};yield{type:'finish',reason:{kind:'stop'}}}
async function* toolChunks(name,args){const id='reused-smoke-wire-id';yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)};yield{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}}}
export function apply(ctx){
 const calls=[],receipts=[]
 const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
 ctx.tools.register({name:'rp_present',description:'Commit synthetic formal public prose.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
 output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:value.text}],presentationMeta:(_args,value)=>({rpLastStep:{schemaVersion:1,record:value}})},
 execute:async(args,exec)=>{const record={id:crypto.randomUUID(),status:'complete',text:args.text,createdAt:new Date().toISOString()};receipts.push({sessionId:exec.agent.session.id,...record});exec.concludeTurn();return record}})
 const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,v)=>v,
 listModels:async provider=>[{provider,id:'main',name:'main'}],resolveModel:async(provider,id)=>({provider,id,name:id}),
 async prepareCall(provider,id){return{model:await this.resolveModel(provider,id),stream:options=>this.stream(options)}},
 async*stream(options){
  const system=options.system??'',body=options.messages.map(textOf).join('\n')
  if(system.includes('RP_CONTEXT_SUMMARIZE')){
   const input=JSON.parse(body);calls.push({kind:'summarize',ids:input.history.map(row=>row.id)})
   yield*textChunks(JSON.stringify({summaries:input.history.map(row=>({id:row.id,summary:'事实摘要：'+row.text}))}));return
  }
  if(system.includes('RP_CONTEXT_PREPARE')){
   const input=JSON.parse(body);if(input.database!==null)throw Error('Standalone preparation unexpectedly has database')
   calls.push({kind:'prepare',readHistory:input.readHistory.map(row=>({id:row.id,text:row.text,source:row.source}))})
   if(!input.readHistory.length){yield*textChunks(JSON.stringify({readHistory:[input.history[0].id],commit:false}));return}
   yield*textChunks(JSON.stringify({historyOperations:input.history.map((row,i)=>({id:row.id,mode:i===input.history.length-1?'full':i===1?'index':'summary'})),unresolved:['门外脚印的主人尚未确认。'],notes:'只保留已经发生的事。',commit:true}));return
  }
  const human=options.messages.findLastIndex(m=>m.role==='user'&&m.source?.kind==='user')
  if(human<0){yield*textChunks('Synthetic context story');return}
  if(!options.tools?.some(tool=>tool.name==='rp_present'))throw Error('Synthetic native terminal tool missing')
  const agent=ctx.agents.currentInitiator(),count=receipts.filter(row=>row.sessionId===agent.session.id).length+1
  calls.push({kind:'main',sessionId:agent.session.id})
  yield*toolChunks('rp_present',{text:['门保持关闭，门外传来脚步声。','脚步声停在门前，守卫没有进门。','守卫离开，门外留下一行脚印。'][count-1]??'故事继续。'})
 }}
 ctx.llm.registerAdapter(['smoke-local'],adapter)
 ctx.commands.register({name:'context_fixture_adopt',description:'Local fixture: content-only replacement in a real native maintenance turn',input:{hint:'<synthetic prose>'},handler:async({agent,rawInput})=>{
  if(agent.status!=='idle')throw Error('Fixture requires an idle Agent')
  const events=agent.session.snapshotEvents(),current=agent.session.surface.nodes.map(seq=>events.find(event=>event.seq===seq)).findLast(event=>event?.type==='tool/result'&&event.data?.meta?.rpLastStep)
  if(!current)throw Error('No fixture presentation')
  let accepted
  const maintenanceId=crypto.randomUUID()
  const dispose=ctx.on('agent/pre-step',({agent:actual,messages},next)=>{
   if(actual!==agent)return next()
   if(messages?.length!==1||messages[0].id!==maintenanceId)return next()
   if(!agent.session.surface.nodes.includes(current.seq))throw Error('Fixture source changed')
   accepted=agent.session.append('tool/result',{...current.data,message:{...current.data.message,content:[{type:'text',text:rawInput.trim()}]}},{surfaceOp:{op:'replace',startSeq:current.seq,endSeq:current.seq},sourceEventSeqs:[...new Set([...(current.sourceEventSeqs??[]),current.seq])]})
   return{kind:'reject'}
  })
  try{agent.followup({id:maintenanceId,role:'user',source:{kind:'user'},content:[{type:'text',text:'Local fixture prose correction.'}]});await agent.whenIdle();await ctx.sessionPersistence.flush();if(!accepted)throw Error('Fixture adoption did not execute');return{kind:'success',text:'Fixture content adopted; host maintenance turn is blocked.',sourceEventSeq:accepted.seq}}
  finally{dispose()}
 }})
 ctx.connection.fetch.register({path:'/api/native-smoke',methods:['POST'],requestBody:'buffered',fetch:async request=>{try{
  const input=await request.json()
  if(input.action==='create')return Response.json(await invoke('create',{agentPreset:'native-smoke-story'},request.signal))
  if(input.action==='snapshot'){
   const observed=await ctx.sessionQuery.observeSession(input.sessionId)
   try{return Response.json({events:observed.events,messages:ctx.agents.get(input.sessionId)?.session.deriveMessages(),calls,receipts})}finally{observed[Symbol.dispose]()}
  }
  const agent=ctx.agents.get(input.sessionId)
  if(!agent||agent.session.id!==input.sessionId)throw Error('Live fixture story required')
  if(input.action==='run'){await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:input.text}]},request.signal);await agent.whenIdle();return Response.json({receipts:receipts.filter(row=>row.sessionId===input.sessionId),calls})}
  if(input.action==='adopt'){const dispatch=await ctx.typertGateway.invoke({namespace:'commands',method:'execute',args:{agentId:input.sessionId,line:'/context_fixture_adopt '+input.text,submittedAttachments:[]},peer:ctx.connection.browserPeer,signal:request.signal});if(!dispatch)throw Error('Fixture command was not dispatched');return Response.json(dispatch)}
  if(input.action==='prepare')return Response.json({prepared:await ctx.get('rpContext').prepare({sessionId:input.sessionId,agent,presentationId:input.presentationId,baseModel:{provider:'smoke-local',model:'main'},packet:{playerAction:'我查看门外脚印。',resolvedChanges:['守卫已离开。'],visibleConsequences:['门外留着脚印。'],proseConstraints:[],variables:{}},signal:request.signal}),calls,receipts:receipts.filter(row=>row.sessionId===input.sessionId),hasDatabase:!!ctx.get('rpDatabase')})
  return Response.json({error:'Unknown fixture action'},{status:400})
 }catch(error){return Response.json({error:{message:error.message,code:error.code,stack:error.stack}},{status:500})}}})
}

