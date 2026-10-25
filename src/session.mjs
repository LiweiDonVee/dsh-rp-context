import {ContextError} from './core.mjs'
import {isDeepStrictEqual} from 'node:util'

const text=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
const messageOf=event=>event.type==='user/message'?event.data:event.data?.message

/** Derive visible sources, retaining compacted originals but excluding replaced branches. */
export function projectSession(snapshot) {
  const events=[...new Map((snapshot.records??[]).map(row=>row.type==='event'?row.event:row).filter(event=>Number.isSafeInteger(event?.seq)).map(event=>[event.seq,event])).values()].sort((a,b)=>a.seq-b.seq)
  const bySeq=new Map(events.map(event=>[event.seq,event])),nodes=[],semantic=new Map()
  for(const event of events){
    if(event.surfaceOp==='append'){nodes.push(event.seq);semantic.set(event.seq,[event.seq]);continue}
    if(event.surfaceOp?.op!=='replace')continue
    const start=nodes.indexOf(event.surfaceOp.startSeq),end=nodes.indexOf(event.surfaceOp.endSeq)
    if(start<0||end<start)continue
    const replaced=nodes.slice(start,end+1)
    const preserved=messageOf(event)?.source?.kind==='compact-checkpoint'?replaced.flatMap(seq=>semantic.get(seq)??[seq]):[]
    semantic.set(event.seq,[...preserved,event.seq]);nodes.splice(start,end-start+1,event.seq)
  }
  const activeSeqs=new Set(nodes.flatMap(seq=>semantic.get(seq)??[seq]))
  const activeEvents=events.filter(event=>activeSeqs.has(event.seq))
  const messages=nodes.map(seq=>messageOf(bySeq.get(seq))).filter(Boolean)
  const activeAnchors=activeEvents.filter(event=>event.type==='assistant/message'&&typeof event.data?.message?.id==='string').map(event=>event.data.message.id)
  return {sessionId:snapshot.header?.id,parentSession:snapshot.header?.parentSession,header:snapshot.header,projections:snapshot.projections,
    events,visible: nodes.map(seq=>bySeq.get(seq)),activeEvents,messages,activeAnchors,currentAnchor:activeAnchors.at(-1)??null}
}

/** Read the complete canonical history under the authenticated owner peer. */
export function createOwnerReader(ctx) {
  return async function read(sessionId,signal){
    if(typeof sessionId!=='string'||!sessionId.trim())throw new ContextError('INVALID_SESSION','A session is required')
    signal?.throwIfAborted()
    const lifetime=new AbortController(),combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal
    let iterator
    try{
      const stream=await ctx.typertGateway.stream({namespace:'session',method:'follow',args:{request:{address:{kind:'session',sessionId},maxMessages:100}},peer:ctx.connection.browserPeer,signal:combined})
      iterator=stream[Symbol.asyncIterator]();const first=await iterator.next();combined.throwIfAborted()
      const snapshot=first.value
      if(first.done||snapshot?.type!=='snapshot'||snapshot.header?.id!==sessionId||!Array.isArray(snapshot.records))throw new ContextError('SESSION_NOT_FOUND','Session is unavailable',404)
      const records=[...snapshot.records];let page=snapshot,before=snapshot.cursor+1
      while(page.hasMore){
        const next=Math.min(...page.records.map(row=>(row.type==='event'?row.event:row)?.seq))
        if(!Number.isSafeInteger(next)||next<0||next>=before)throw new ContextError('HISTORY_INVALID','Session history did not advance',503)
        before=next
        page=await ctx.typertGateway.invoke({namespace:'session',method:'page',args:{request:{address:{kind:'session',sessionId},throughSeq:snapshot.cursor,beforeSeq:before,maxMessages:500}},peer:ctx.connection.browserPeer,signal:combined})
        combined.throwIfAborted()
        if(!Array.isArray(page?.records)||typeof page.hasMore!=='boolean')throw new ContextError('HISTORY_INVALID','Session history is unavailable',503)
        records.push(...page.records)
      }
      return projectSession({...snapshot,records})
    }catch(error){
      if(combined.aborted)combined.throwIfAborted()
      if(error instanceof ContextError)throw error
      if(['gateway/forbidden','gateway/access-denied'].includes(error?.code))throw new ContextError('FORBIDDEN','Session access was denied',403)
      throw new ContextError('SESSION_UNAVAILABLE','Session is unavailable',503)
    }finally{lifetime.abort();try{await iterator?.return?.()}catch{/* Reader disposal does not replace its accepted result. */}}
  }
}

/** Only canonical successful rp_present receipts form narrative history. */
export function narrativeHistory(view,{includeInactive=false}={}) {
  const active=new Set(view.activeAnchors),latest=new Map(),calls=new Map(),chains=new Map(),results=[]
  let action=''
  for(const event of view.events){
    const identity=`${event.data?.turn}:${event.data?.step}`
    if(event.type==='user/message'&&event.data?.source?.kind==='user')action=text(event.data)
    if(event.type==='assistant/message')latest.set(identity,{event,action})
    if(event.type==='tool/call'&&event.data?.name==='rp_present'){
      const owner=latest.get(identity),message=owner?.event.data?.message
      if((includeInactive||active.has(message?.id))&&message?.content?.some(block=>block.type==='tool-call'&&block.name==='rp_present'&&block.id===event.data.callId))calls.set(event.seq,{...owner,call:event})
    }
  }
  const identity=event=>{const value=structuredClone(event.data);if(value?.message)delete value.message.content;return value}
  for(const event of view.events){
    if(event.type!=='tool/result')continue
    const sources=event.sourceEventSeqs
    if(!Array.isArray(sources)||!sources.length||new Set(sources).size!==sources.length||sources.some(seq=>!Number.isSafeInteger(seq)||seq>=event.seq))continue
    if(event.surfaceOp?.op==='replace'){
      const previous=chains.get(event.surfaceOp.startSeq)
      if(!previous||event.surfaceOp.endSeq!==event.surfaceOp.startSeq||!sources.includes(previous.event.seq)||!sources.includes(previous.owner.call.seq)
        ||sources.some(seq=>seq!==previous.owner.call.seq&&chains.get(seq)?.base.seq!==previous.base.seq)||!isDeepStrictEqual(identity(event),identity(previous.event)))continue
      chains.set(event.seq,{...previous,event});continue
    }
    if(event.surfaceOp!=='append'||sources.length!==1)continue
    const owner=calls.get(sources[0]),message=event.data?.message,envelope=event.data?.meta?.rpLastStep,item=envelope?.record
    if(!owner||message?.isError||message?.source?.kind!=='tool'||message.toolCallId!==message.source.callId||message.toolCallId!==owner.call.data.callId
      ||event.data.turn!==owner.call.data.turn||event.data.step!==owner.call.data.step||envelope?.schemaVersion!==1||item?.status!=='complete'||typeof item.id!=='string'||typeof item.text!=='string')continue
    chains.set(event.seq,{owner,item,base:event,event})
  }
  for(const event of includeInactive?view.events:view.activeEvents){
    const chain=chains.get(event.seq);if(!chain)continue
    const{owner,item,base}=chain
    results.push({id:JSON.stringify([item.id,event.seq]),anchor:owner.event.data.message.id,turn:base.data.turn,action:typeof item.playerAction==='string'?item.playerAction:owner.action,text:event.seq===base.seq?item.text:text(event.data.message),createdAt:item.createdAt,...(typeof item.factReceiptId==='string'?{factReceiptId:item.factReceiptId}:{}),
      source:{sessionId:view.sessionId,presentationId:item.id,assistantMessageId:owner.event.data.message.id,callSeq:owner.call.seq,baseResultSeq:base.seq,resultSeq:event.seq,callId:owner.call.data.callId}})
  }
  return results
}
