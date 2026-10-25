import {ContextError} from './core.mjs'
const fields={state:['sessionId'],configure:['sessionId','settings','expectedRevision'],read:['sessionId','historyIds'],search:['sessionId','query'],represent:['sessionId','historyId','mode','summary','expectedRevision'],authorNote:['sessionId'],setAuthorNote:['sessionId','text','expectedRevision'],material:['sessionId','presentationId']}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256
const failure=(status,code,message)=>Response.json({error:{code,message}},{status,headers:{'cache-control':'no-store'}})
function valid(input){
  if(!object(input)||!Object.hasOwn(fields,input.action)||!id(input.sessionId)||Object.keys(input).some(key=>key!=='action'&&!fields[input.action].includes(key)))return false
  if(['configure','represent','setAuthorNote'].includes(input.action)&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0))return false
  if(input.action==='setAuthorNote'&&(typeof input.text!=='string'||input.text.length>64000))return false
  if(input.action==='material'&&!id(input.presentationId))return false
  if(input.action==='configure'&&!object(input.settings))return false
  if(input.action==='read'&&(!Array.isArray(input.historyIds)||input.historyIds.length>100||input.historyIds.some(value=>!id(value))))return false
  if(input.action==='search'&&(typeof input.query!=='string'||input.query.length>4000))return false
  if(input.action==='represent'&&(!id(input.historyId)||!['full','summary','index'].includes(input.mode)||input.summary!==undefined&&(typeof input.summary!=='string'||input.summary.length>64000)))return false
  return true
}
function errorResponse(error){
  if(error instanceof ContextError)return failure(error.status??400,error.code,error.message)
  if(error?.name==='AbortError')return failure(499,'CANCELLED','The request was cancelled')
  return failure(503,'UNAVAILABLE','Context is temporarily unavailable')
}
export function createContextRoutes(service){
  let stopped=false;const streams=new Set()
  return{
    async request(request){
      if(stopped)return failure(503,'UNAVAILABLE','Context has been unloaded')
      let input;try{input=await request.json()}catch{return failure(400,'INVALID_REQUEST','A JSON operation is required')}
      if(!valid(input))return failure(400,'INVALID_REQUEST','Invalid context operation')
      try{request.signal.throwIfAborted();const{action,...args}=input;return Response.json(await service[action]({...args,signal:request.signal}),{headers:{'cache-control':'no-store'}})}catch(error){return errorResponse(error)}
    },
    async events(request){
      if(stopped)return failure(503,'UNAVAILABLE','Context has been unloaded')
      const sessionId=new URL(request.url).searchParams.get('sessionId');if(!id(sessionId))return failure(400,'INVALID_REQUEST','A session is required')
      try{
        await service.authorize(sessionId,request.signal);if(stopped||request.signal.aborted)return new Response(null,{status:204})
        let cleanup=()=>{}
        const body=new ReadableStream({start(controller){
          let closed=false,unsubscribe=()=>{};const encoder=new TextEncoder()
          const write=text=>{if(closed)return;const bytes=encoder.encode(text);if(controller.desiredSize<bytes.byteLength){cleanup();return}controller.enqueue(bytes)}
          const timer=setInterval(()=>write(': heartbeat\n\n'),15000);timer.unref?.()
          const aborted=()=>cleanup()
          cleanup=cancelled=>{if(closed)return;closed=true;clearInterval(timer);unsubscribe();streams.delete(cleanup);request.signal.removeEventListener('abort',aborted);if(cancelled!==true)controller.close()}
          streams.add(cleanup);request.signal.addEventListener('abort',aborted,{once:true})
          unsubscribe=service.subscribe(sessionId,input=>{
            const event={type:input.type==='stage'?'stage':'changed',sessionId}
            for(const key of ['id','stageId','status','code','model'])if(typeof input[key]==='string')event[key]=input[key].slice(0,160)
            if(Number.isSafeInteger(input.step))event.step=input.step
            write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          })
          if(stopped||request.signal.aborted)cleanup();else write(`event: connected\ndata: ${JSON.stringify({type:'connected',sessionId})}\n\n`)
        },cancel(){cleanup(true)}},{highWaterMark:16384,size:chunk=>chunk.byteLength})
        return new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'}})
      }catch(error){return errorResponse(error)}
    },
    close(){stopped=true;for(const dispose of streams)dispose()},
  }
}
