import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

function fixture(){
  const events=[],handlers=new Map(),calls=[];let reply={commit:true,notes:'沿用现有事实'}
  const on=(name,fn)=>{const set=handlers.get(name)??new Set();set.add(fn);handlers.set(name,set);return()=>set.delete(fn)}
  const agent={id:'s',session:{id:'s',header:{id:'s'},snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'base',model:'main'}})},ctx:{on,tools:{register:()=>()=>{}}}}
  const ctx={on,get:()=>undefined,emit:()=>{},agents:{get:id=>id==='s'?agent:undefined,list:()=>[agent]},connection:{browserPeer:{id:'owner'}},
    llm:{prepareCall:async config=>({config,stream:async function*(input){calls.push({config,input});yield{type:'text-delta',index:0,text:JSON.stringify(reply)};yield{type:'finish',reason:{kind:'stop'}}}})},
    typertGateway:{stream:async input=>({async *[Symbol.asyncIterator](){yield{type:'snapshot',header:{id:input.args.request.address.sessionId},cursor:20,hasMore:false,records:events.map(event=>({type:'event',event}))}}})}}
  return{ctx,agent,events,calls,handlers,setReply:value=>reply=value}
}
const message=(seq,id,content)=>({seq,type:'assistant/message',surfaceOp:'append',data:{turn:seq,step:1,message:{id,role:'assistant',source:{kind:'model'},content}}})

function appendNarrative(f,index){
  const seq=index*4,id='n'+index,turn=seq+1
  f.events.push({seq,type:'user/message',surfaceOp:'append',data:{id:'u'+index,source:{kind:'user'},content:[{type:'text',text:'action'}]}})
  f.events.push(message(seq+1,'m'+index,[{type:'tool-call',name:'rp_present',id:'reused'}]))
  f.events.push({seq:seq+2,type:'tool/call',data:{turn,step:1,name:'rp_present',callId:'reused'}})
  f.events.push({seq:seq+3,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[seq+2],data:{turn,step:1,message:{id:'r'+index,toolCallId:'reused',source:{kind:'tool',callId:'reused'},content:[]},meta:{rpLastStep:{schemaVersion:1,record:{id,text:'exact '+index,status:'complete'}}}}})
}

test('unrelated older missing summaries do not block choosing index or full for one narrative',async()=>{
  const {createContextHost}=await import('../src/host.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-modes-')),f=fixture();let service
  try{
    for(let index=0;index<3;index++)appendNarrative(f,index)
    service=await createContextHost(f.ctx,{directory})
    const state=await service.state({sessionId:'s'})
    const configured=await service.configure({sessionId:'s',settings:{recentTurns:1},expectedRevision:state.revision})
    const changed=await service.represent({sessionId:'s',historyId:'n0',mode:'index',expectedRevision:configured.revision})
    assert.equal(changed.representations.n0.mode,'index')
    assert.equal(f.calls.length,0)
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('lifecycle listener is installed before initial asynchronous inheritance can admit another agent',async()=>{
  const {createContextHost}=await import('../src/host.mjs'),f=fixture();let release,service
  const gate=new Promise(resolve=>release=resolve)
  f.agent.session.header.parentSession='parent'
  const store={view:async()=>{await gate;return{revision:0}},forkSession:async()=>({revision:1})}
  const pending=createContextHost(f.ctx,{store})
  try{
    await new Promise(resolve=>setImmediate(resolve))
    assert.ok(f.handlers.has('agent/created'))
    const names=[],agent={id:'new',session:{id:'new',header:{id:'new'},snapshotEvents:()=>[]},ctx:{tools:{register:tool=>{names.push(tool.name);return()=>{}}}}}
    for(const listener of f.handlers.get('agent/created'))await listener({agent})
    assert.ok(names.includes('rp_context_read'))
  }finally{release();service=await pending;await service.close()}
})

test('canonical user replacements invalidate the context inspector without waiting for another model turn',async()=>{
  const{createContextHost}=await import('../src/host.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-notify-')),f=fixture();let service
  try{
    service=await createContextHost(f.ctx,{directory});let changed=0;service.subscribe('s',()=>changed++)
    for(const listener of f.handlers.get('session/event')??[])listener(f.agent.session,{type:'user/message'})
    assert.equal(changed,1)
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('native preparation consumes only canonical history and honors disabled settings without calling models',async()=>{
  const module=await import('../src/host.mjs').catch(()=>({}));assert.equal(typeof module.createContextHost,'function')
  const directory=await mkdtemp(join(tmpdir(),'rp-context-host-')),f=fixture();let service
  try{
    f.events.push(message(1,'current',[]));service=await module.createContextHost(f.ctx,{directory})
    const result=await service.prepare({sessionId:'s',agent:f.agent,packet:{playerAction:'等待'},signal:new AbortController().signal})
    assert.equal(result.materials.guidance,'沿用现有事实')
    assert.equal(f.calls.length,1);assert.match(f.calls[0].input.system,/RP_CONTEXT_PREPARE/)
    const state=await service.state({sessionId:'s'})
    await service.configure({sessionId:'s',settings:{enabled:false},expectedRevision:state.revision})
    assert.equal(await service.prepare({sessionId:'s',agent:f.agent,packet:{playerAction:'等待'}}),null)
    assert.equal(f.calls.length,1)
    await assert.rejects(service.prepare({sessionId:'other',agent:f.agent,packet:{}}),{code:'AGENT_MISMATCH'})
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('canonical material records exclude a rewritten branch and tools keep original narrative available',async()=>{
  const {createContextHost}=await import('../src/host.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-canonical-')),f=fixture();let service
  try{
    f.events.push({seq:0,type:'user/message',surfaceOp:'append',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'推门'}]}})
    f.events.push(message(1,'one',[{type:'tool-call',name:'rp_present',id:'reused'}]))
    f.events.push({seq:2,type:'tool/call',data:{turn:1,step:1,name:'rp_present',callId:'reused'}})
    f.events.push({seq:3,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[2],data:{turn:1,step:1,message:{id:'result',toolCallId:'reused',source:{kind:'tool',callId:'reused'},content:[{type:'text',text:'门仍关闭'}]},meta:{rpLastStep:{schemaVersion:1,record:{id:'narrative',text:'门仍关闭',status:'complete'}}}}})
    service=await createContextHost(f.ctx,{directory})
    assert.equal((await service.state({sessionId:'s'})).history[0].content,'门仍关闭')
    const read=await service.read({sessionId:'s',agent:f.agent,historyIds:['narrative']})
    assert.equal(read.records[0].text,'门仍关闭')
    f.events.push({seq:4,type:'user/message',surfaceOp:{op:'replace',startSeq:1,endSeq:3},data:{id:'undo',source:{kind:'runtime-context'},content:[]}})
    assert.equal((await service.state({sessionId:'s'})).history.length,0)
    await assert.rejects(service.read({sessionId:'s',agent:f.agent,historyIds:['narrative']}),{code:'HISTORY_NOT_FOUND'})
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})
