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
    const historyId=JSON.stringify(['n0',3])
    const changed=await service.represent({sessionId:'s',historyId,mode:'index',expectedRevision:configured.revision})
    assert.equal(changed.representations[historyId].mode,'index')
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
    const historyId=JSON.stringify(['narrative',3])
    const read=await service.read({sessionId:'s',agent:f.agent,historyIds:[historyId]})
    assert.equal(read.records[0].text,'门仍关闭')
    f.events.push({seq:4,type:'user/message',surfaceOp:{op:'replace',startSeq:1,endSeq:3},data:{id:'undo',source:{kind:'runtime-context'},content:[]}})
    assert.equal((await service.state({sessionId:'s'})).history.length,0)
    await assert.rejects(service.read({sessionId:'s',agent:f.agent,historyIds:[historyId]}),{code:'HISTORY_NOT_FOUND'})
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('optional narrative service is preferred and original-only legacy caches do not follow adoption',async()=>{
  const{createContextHost}=await import('../src/host.mjs'),{createContextStore}=await import('../src/store.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-revisions-')),f=fixture();let service
  try{
    appendNarrative(f,0);appendNarrative(f,1)
    const store=await createContextStore({directory})
    await store.cacheSummaries('s',{summaries:[{id:'n0',summary:'Original cached summary'}],expectedRevision:0})
    let records=[{id:JSON.stringify(['n0',3]),ref:{sessionId:'s',presentationId:'n0',assistantMessageId:'m0',callSeq:2,baseResultSeq:3,resultSeq:3},turn:1,action:'Action',text:'Original from optional service'}]
    const readerCalls=[]
    f.ctx.get=name=>name==='rpLastStep'?{narratives:async input=>{readerCalls.push(input);return{records}}}:undefined
    service=await createContextHost(f.ctx,{store})
    let state=await service.state({sessionId:'s',agent:f.agent})
    assert.equal(state.history.length,1)
    assert.equal(state.history[0].text,'Original from optional service')
    assert.equal(state.history[0].summary,'Original cached summary')
    assert.equal(readerCalls[0].agent,f.agent)
    records=[{...records[0],id:JSON.stringify(['n0',7]),ref:{...records[0].ref,resultSeq:7},text:'Adopted service prose'}]
    state=await service.state({sessionId:'s',agent:f.agent})
    assert.equal(state.history[0].text,'Adopted service prose')
    assert.equal(state.history[0].summary,undefined)
    records=[{...records[0],id:JSON.stringify(['n0',3]),ref:{...records[0].ref,resultSeq:3},text:'Original from optional service'}]
    assert.equal((await service.state({sessionId:'s',agent:f.agent})).history[0].summary,'Original cached summary')
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('host selects only an explicitly versioned material service and keeps receipt metadata outside packet',async()=>{
  const{createContextHost}=await import('../src/host.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-v2-host-')),f=fixture();let service,accessCalls=0
  const binding={schemaVersion:2,sources:[{key:'source',databaseId:'db',version:1}],factEntryRefs:[]}
  const db={apiVersion:2,hasBinding:()=>true,materialAccess:async()=>{accessCalls++;return{snapshot:async()=>({revision:2,binding,entries:[],notes:[]}),search:async()=>({revision:2,candidates:[],required:[],degraded:[]}),apply:()=>({entries:[],notes:[]}),select:()=>[],commit:()=>{throw Error('No operations')}}}}
  try{
    f.events.push(message(1,'current',[]));f.ctx.get=name=>name==='rpDatabase'?db:undefined
    service=await createContextHost(f.ctx,{directory})
    const result=await service.prepare({sessionId:'s',agent:f.agent,packet:{playerAction:'Wait'},presentationId:'presentation',factReceiptId:'receipt',story:{title:'Story'}})
    assert.equal(accessCalls,1)
    assert.deepEqual(result.database,{binding,revision:2,entryRefs:[]})
    const input=JSON.parse(f.calls[0].input.messages[0].content[0].text)
    assert.equal(input.factReceiptId,'receipt');assert.equal(input.story.title,'Story');assert.deepEqual(input.packet,{playerAction:'Wait'})
    db.apiVersion=undefined;db.effective=async()=>({revision:2,databaseId:'legacy',version:1,entries:[],notes:[]});db.search=async()=>({revision:2,candidates:[],required:[]});db.applyToSnapshot=()=>({entries:[],notes:[]});db.selectFromSnapshot=()=>[]
    const legacy=await service.prepare({sessionId:'s',agent:f.agent,packet:{}})
    assert.equal(accessCalls,1);assert.equal(legacy.database.databaseId,'legacy')
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('owner note methods preserve lineage and only canonical accepted outcomes consume a note',async()=>{
  const{createContextHost}=await import('../src/host.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-note-host-')),f=fixture();let service
  try{
    appendNarrative(f,0);service=await createContextHost(f.ctx,{directory})
    const saved=await service.setAuthorNote({sessionId:'s',text:'Owner guidance',expectedRevision:0})
    assert.equal((await service.authorNote({sessionId:'s'})).version,saved.note.version)
    const preparation=await service.prepare({sessionId:'s',agent:f.agent,presentationId:'pending',packet:{}})
    assert.equal(preparation.authorNote.claimId,'pending')
    await assert.rejects(service.presentationOutcome({sessionId:'s',presentationId:'pending',status:'accepted'}),{code:'PRESENTATION_NOT_ACCEPTED'})
    await service.presentationOutcome({sessionId:'s',presentationId:'pending',status:'failed-after-freeze'})
    assert.equal((await service.authorNote({sessionId:'s'})).status,'claimed')
    appendNarrative(f,1)
    f.ctx.get=name=>name==='rpLastStep'?{material:async input=>({presentationId:input.presentationId,packet:{},contextPreparation:{...preparation,authorNote:{...preparation.authorNote,version:99}},status:'complete'})}:undefined
    await assert.rejects(service.presentationOutcome({sessionId:'s',presentationId:'n1',claimId:'pending',status:'accepted'}),{code:'PRESENTATION_NOT_ACCEPTED'})
    f.ctx.get=name=>name==='rpLastStep'?{material:async input=>({presentationId:input.presentationId,packet:{},contextPreparation:preparation,status:'complete'})}:undefined
    await service.presentationOutcome({sessionId:'s',presentationId:'n1',claimId:'pending',status:'accepted'})
    assert.equal((await service.authorNote({sessionId:'s'})).status,'consumed')
    f.ctx.get=()=>undefined
    await assert.rejects(service.material({sessionId:'s',presentationId:'n1'}),{code:'MATERIAL_UNAVAILABLE'})
    f.ctx.get=name=>name==='rpLastStep'?{material:async input=>({presentationId:input.presentationId,packet:{},contextPreparation:preparation,status:'complete'})}:undefined
    assert.equal((await service.material({sessionId:'s',presentationId:'n1'})).contextPreparation.materials.guidance.includes('Owner guidance'),true)
    await assert.rejects(service.setAuthorNote({sessionId:'other',agent:f.agent,text:'Bad',expectedRevision:preparation.revision}),{code:'AGENT_MISMATCH'})
  }finally{await service?.close();await rm(directory,{recursive:true,force:true})}
})

test('unload cancels preparation and releases its not-yet-compiled author claim',async()=>{
  const{createContextHost}=await import('../src/host.mjs'),{createContextStore}=await import('../src/store.mjs'),directory=await mkdtemp(join(tmpdir(),'rp-context-note-disposal-')),f=fixture();let service,release,started
  const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve)
  try{
    const store=await createContextStore({directory});await store.setAuthorNote('s',{text:'Pending note',expectedRevision:0});f.events.push(message(1,'current',[]))
    service=await createContextHost(f.ctx,{store,callModel:async()=>{started();await gate;return{text:'{"commit":true}'}}})
    const pending=service.prepare({sessionId:'s',agent:f.agent,presentationId:'presentation',packet:{}})
    const checked=assert.rejects(pending,{code:'CANCELLED'})
    await ready;await service.close();release();await checked
    assert.equal((await store.view('s')).authorNote.status,'pending')
    assert.equal([...f.handlers.values()].every(handlers=>handlers.size===0),true)
  }finally{release();await service?.close();await rm(directory,{recursive:true,force:true})}
})
