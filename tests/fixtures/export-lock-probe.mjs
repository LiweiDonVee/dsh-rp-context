// Narrow real-SDK export lock composition. No writer, Database, LastStep or restore work.
export const name='context-export-lock-probe'
export const inject=['llm','agents','connection','typertGateway']

export function apply(ctx){
  let modelCalls=0,ownerScopes=0,ready,release
  const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
  const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,value)=>value,
    listModels:async provider=>[{provider,id:'main',name:'Export guard local'}],resolveModel:async(provider,id)=>({provider,id,name:id}),
    async prepareCall(provider,id){return{model:await this.resolveModel(provider,id),stream:options=>this.stream(options)}},
    async*stream(options){
      modelCalls++;if(!ready)throw Error('Unexpected model request outside explicit busy guard')
      const started=ready;ready=undefined
      const gate=new Promise((done,reject)=>{
        const abort=()=>reject(options.signal?.reason??new DOMException('Aborted','AbortError'))
        release=()=>{options.signal?.removeEventListener('abort',abort);done()}
        options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort()
      })
      started();await gate
      yield{type:'text-delta',index:0,text:'Export guard fixture finished.'};yield{type:'finish',reason:{kind:'stop'}}
    }}
  ctx.llm.registerAdapter(['context-export-lock-local'],adapter)
  ctx.connection.fetch.register({path:'/api/context-export-lock',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try{
      const input=await request.json(),context=ctx.get('rpContext'),signal=request.signal
      if(input.action==='create'){
        const created=await invoke('create',{agentPreset:'context-export-lock-story'},signal)
        const state=await context.state({sessionId:created.sessionId,signal})
        const configured=await context.configure({sessionId:created.sessionId,settings:{recentTurns:1,maxChars:9999},expectedRevision:state.revision,signal})
        await context.setAuthorNote({sessionId:created.sessionId,text:'Export lock owner note',expectedRevision:configured.revision,signal})
        return Response.json(created)
      }
      const agent=ctx.agents.get(input.sessionId)
      if(!agent)throw Error('A real live fixture Agent is required')
      if(input.action==='export')return Response.json({ok:true,status:agent.status,state:await context.exportState({sessionIds:[input.sessionId],signal}),modelCalls,ownerScopes})
      if(input.action==='underMaintenance'){
        ownerScopes++;let insideStatus
        const state=await agent.runMaintenance(async()=>{insideStatus=agent.status;return context.exportState({sessionIds:[input.sessionId],signal})})
        return Response.json({ok:true,insideStatus,status:agent.status,state,modelCalls,ownerScopes})
      }
      if(input.action==='startBusy'){
        const started=new Promise(done=>ready=done)
        agent.followup({id:crypto.randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Run the explicit export busy guard.'}]})
        await started;return Response.json({ok:true,status:agent.status,modelCalls,events:agent.session.snapshotEvents().length})
      }
      if(input.action==='releaseBusy'){
        release?.();release=undefined;await agent.whenIdle()
        return Response.json({ok:true,status:agent.status,modelCalls,events:agent.session.snapshotEvents().length})
      }
      return Response.json({ok:false,error:{code:'INVALID_FIXTURE_ACTION'}},{status:400})
    }catch(error){return Response.json({ok:false,error:{code:error.code??'EXPORT_LOCK_FIXTURE_ERROR',message:error.message}})}
  }})
}
