// Local deterministic models; no paid providers, private profiles, or source imports.
export const name='native-smoke-probe'
export const inject=['llm','agents','tools','connection','typertGateway']
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
   yield*textChunks(JSON.stringify({historyOperations:input.history.map((row,i)=>({id:row.id,mode:['summary','index','full'][i]})),unresolved:['门外脚印的主人尚未确认。'],notes:'只保留已经发生的事。',commit:true}));return
  }
  const human=options.messages.findLastIndex(m=>m.role==='user'&&m.source?.kind==='user')
  if(human<0){yield*textChunks('Synthetic context story');return}
  if(!options.tools?.some(tool=>tool.name==='rp_present'))throw Error('Synthetic native terminal tool missing')
  const agent=ctx.agents.currentInitiator(),count=receipts.filter(row=>row.sessionId===agent.session.id).length+1
  calls.push({kind:'main',sessionId:agent.session.id})
  yield*toolChunks('rp_present',{text:['门保持关闭，门外传来脚步声。','脚步声停在门前，守卫没有进门。','守卫离开，门外留下一行脚印。'][count-1]??'故事继续。'})
 }}
 ctx.llm.registerAdapter(['smoke-local'],adapter)
 ctx.connection.fetch.register({path:'/api/native-smoke',methods:['POST'],requestBody:'buffered',fetch:async request=>{try{
  const input=await request.json()
  if(input.action==='create')return Response.json(await invoke('create',{agentPreset:'native-smoke-story'},request.signal))
  const agent=ctx.agents.get(input.sessionId)
  if(!agent||agent.session.id!==input.sessionId)throw Error('Live fixture story required')
  if(input.action==='run'){await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:input.text}]},request.signal);await agent.whenIdle();return Response.json({receipts:receipts.filter(row=>row.sessionId===input.sessionId),calls})}
  if(input.action==='prepare')return Response.json({prepared:await ctx.get('rpContext').prepare({sessionId:input.sessionId,agent,baseModel:{provider:'smoke-local',model:'main'},packet:{playerAction:'我查看门外脚印。',resolvedChanges:['守卫已离开。'],visibleConsequences:['门外留着脚印。'],proseConstraints:[],variables:{}},signal:request.signal}),calls,receipts:receipts.filter(row=>row.sessionId===input.sessionId),hasDatabase:!!ctx.get('rpDatabase')})
  return Response.json({error:'Unknown fixture action'},{status:400})
 }catch(error){return Response.json({error:{message:error.message,code:error.code}},{status:500})}}})
}

