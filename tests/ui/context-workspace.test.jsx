import React from 'react'
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {ContextWorkspace} from '../../src/ContextWorkspace.jsx'
import {createRpContextApi} from '../../src/api.js'

const raw='<script>原文不可执行</script>\n桥已经断了。'
const record={id:'h1',anchor:'m1',turn:1,action:'走到桥边',text:raw,summary:'桥已断。',mode:'summary',content:'桥已断。',source:{sessionId:'story',assistantMessageId:'m1',callSeq:2,resultSeq:3,callId:'call'}}
const state=(extra={})=>({revision:4,settings:{enabled:true,recentTurns:5,maxChars:24000,maxSteps:8},representations:{},summaries:{h1:'桥已断。'},unresolved:['对岸的人是谁？'],history:[record],scope:'preparation-and-writer',...extra})
function client(initial=state()) {
  let value=initial, emit
  const close=vi.fn()
  return {state:vi.fn(async()=>value),configure:vi.fn(async(_id,settings)=>{value={...value,settings,revision:value.revision+1};return value}),represent:vi.fn(async(_id,input)=>{value={...value,revision:value.revision+1,history:value.history.map(item=>item.id===input.historyId?{...item,mode:input.mode,summary:input.summary??item.summary}:item)};return value}),read:vi.fn(async()=>({revision:4,records:[record]})),search:vi.fn(async()=>({revision:4,matches:[{...record,score:1}]})),subscribe:vi.fn((_id,callback)=>{emit=callback;return close}),close,emit:event=>emit(event),set:next=>{value=next}}
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
afterEach(cleanup)

it('saves settings against the captured revision while updates preserve a dirty draft',async()=>{
  const api=client();render(<ContextWorkspace sessionId="story" visible client={api}/>);
  const turns=await screen.findByLabelText('保留完整正文轮数');fireEvent.change(turns,{target:{value:'7'}})
  api.set(state({revision:9}));await act(async()=>api.emit({type:'changed'}))
  expect(turns).toHaveValue(7)
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await waitFor(()=>expect(api.configure).toHaveBeenCalled())
  expect(api.configure.mock.calls[0].slice(0,3)).toEqual(['story',{enabled:true,recentTurns:7,maxChars:24000,maxSteps:8},4])
  expect(screen.getByText(/DSH 主 Agent/)).toBeInTheDocument()
})

it('shows the selected material separately from inert exact original and changes only representation',async()=>{
  const api=client();render(<ContextWorkspace sessionId="story" visible client={api}/>);
  await screen.findByText('走到桥边');expect(screen.getAllByText('桥已断。').length).toBeGreaterThan(0)
  expect(screen.queryByText(raw)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'展开原文'}));expect(await screen.findByLabelText('历史原文')).toHaveTextContent('<script>原文不可执行</script>')
  expect(document.querySelector('script')).toBeNull()
  fireEvent.change(screen.getByLabelText('历史表示'),{target:{value:'index'}})
  fireEvent.click(screen.getByRole('button',{name:'保存表示'}));await waitFor(()=>expect(api.represent).toHaveBeenCalled())
  expect(api.represent.mock.calls[0][1]).toEqual({historyId:'h1',mode:'index',expectedRevision:4})
  expect(record.text).toBe(raw)
})

it('requires an actual summary and retains conflicting representation drafts until explicit reload',async()=>{
  const api=client(state({history:[{...record,summary:undefined,mode:'full',content:raw}],summaries:{}}));api.represent.mockRejectedValue(Object.assign(new Error('版本已变化'),{status:409}))
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  fireEvent.change(screen.getByLabelText('历史表示'),{target:{value:'summary'}})
  fireEvent.click(screen.getByRole('button',{name:'保存表示'}));expect(await screen.findByRole('alert')).toHaveTextContent('请填写事实摘要')
  expect(api.represent).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('事实摘要'),{target:{value:'自写事实摘要'}});fireEvent.click(screen.getByRole('button',{name:'保存表示'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('版本已变化')
  expect(screen.getByLabelText('事实摘要')).toHaveValue('自写事实摘要')
  expect(api.represent.mock.calls[0][1]).toEqual({historyId:'h1',mode:'summary',summary:'自写事实摘要',expectedRevision:4})
  fireEvent.click(screen.getByRole('button',{name:'重新载入上下文'}));await waitFor(()=>expect(screen.getByLabelText('历史表示')).toHaveValue('full'))
})

it('retains conflicting settings and does not reset inputs on stage events',async()=>{
  const api=client();api.configure.mockRejectedValue(Object.assign(new Error('请先重新载入'),{status:409}))
  render(<ContextWorkspace sessionId="story" visible client={api}/>);const budget=await screen.findByLabelText('材料字符预算')
  fireEvent.change(budget,{target:{value:'31000'}})
  await act(async()=>api.emit({type:'stage',stageId:'rp-context.prepare',status:'running',step:2}))
  expect(budget).toHaveValue(31000)
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await screen.findByRole('alert');expect(budget).toHaveValue(31000)
})

it('disposes on hide and session switch and prevents late original or write crossing stories',async()=>{
  const api=client(),read=deferred(),save=deferred();api.read.mockReturnValue(read.promise);api.configure.mockReturnValue(save.promise)
  const view=render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  fireEvent.click(screen.getByRole('button',{name:'展开原文'}));fireEvent.change(screen.getByLabelText('保留完整正文轮数'),{target:{value:'8'}});fireEvent.click(screen.getByRole('button',{name:'保存设置'}))
  api.set(state({revision:2,history:[],unresolved:[]}));view.rerender(<ContextWorkspace sessionId="other" visible client={api}/>);
  await screen.findByText('尚无已确认的叙事');await act(async()=>{read.resolve({records:[record]});save.resolve(state())})
  expect(screen.queryByLabelText('历史原文')).not.toBeInTheDocument();expect(screen.queryByText('走到桥边')).not.toBeInTheDocument()
  expect(api.configure.mock.calls[0][3].aborted).toBe(true);expect(api.read.mock.calls[0][2].aborted).toBe(true);expect(api.close).toHaveBeenCalledTimes(1)
  view.rerender(<ContextWorkspace sessionId="other" visible={false} client={api}/>);expect(api.close).toHaveBeenCalledTimes(2)
})

it('searches current narratives and keeps unresolved questions separate',async()=>{
  const api=client();render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  const matters=screen.getByRole('region',{name:'未决事项'});expect(within(matters).getByText('对岸的人是谁？')).toBeInTheDocument()
  expect(within(screen.getByRole('region',{name:'正式叙事历史'})).queryByText('对岸的人是谁？')).toBeNull()
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索历史'}),{target:{value:'桥'}});fireEvent.click(screen.getByRole('button',{name:'搜索历史'}))
  expect(await screen.findByRole('region',{name:'搜索结果'})).toHaveTextContent('第 1 轮')
  fireEvent.click(within(screen.getByRole('region',{name:'搜索结果'})).getByRole('button',{name:/查看/}))
  expect(api.search.mock.calls[0].slice(0,2)).toEqual(['story','桥'])
})

it('shows empty and missing-summary states without pretending facts exist',async()=>{
  const api=client(state({history:[{...record,summary:undefined,mode:'summary',content:'',needsSummary:true}],summaries:{},unresolved:[]}));const view=render(<ContextWorkspace sessionId="story" visible client={api}/>);
  expect((await screen.findAllByText('未生成摘要')).length).toBeGreaterThan(0)
  expect(screen.getByText(/下次最终呈现/)).toBeInTheDocument();view.rerender(<ContextWorkspace visible client={api}/>);expect(screen.getByText('请先打开一个故事会话')).toBeInTheDocument()
})

describe('native request and event transport',()=>{
  it('sends exact operations and exposes conflicts',async()=>{
    const send=vi.fn(async()=>({ok:true,status:200,json:async()=>state()})),api=createRpContextApi(send)
    await api.configure('story',{enabled:false},7);expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({action:'configure',sessionId:'story',settings:{enabled:false},expectedRevision:7})
    await api.represent('story',{historyId:'h1',mode:'summary',summary:'事实',expectedRevision:8});expect(JSON.parse(send.mock.calls[1][1].body).action).toBe('represent')
    await api.setAuthorNote('story','Owner note',9);expect(JSON.parse(send.mock.calls[2][1].body)).toEqual({action:'setAuthorNote',sessionId:'story',text:'Owner note',expectedRevision:9})
    await api.material('story','presentation');expect(JSON.parse(send.mock.calls[3][1].body)).toEqual({action:'material',sessionId:'story',presentationId:'presentation'})
    send.mockResolvedValue({ok:true,status:200,json:async()=>null});expect(await api.authorNote('story')).toBeNull()
    send.mockResolvedValue({ok:false,status:409,json:async()=>({error:{code:'CONFLICT',message:'已更新'}})})
    await expect(api.state('story')).rejects.toMatchObject({status:409,code:'CONFLICT',message:'已更新'})
  })
})

it('keeps a dirty draft usable after hiding an in-flight save and ignores an old event callback',async()=>{
  const api=client(),save=deferred();api.configure.mockReturnValueOnce(save.promise)
  const view=render(<ContextWorkspace sessionId="story" visible client={api}/>);const turns=await screen.findByLabelText('保留完整正文轮数')
  fireEvent.change(turns,{target:{value:'9'}});fireEvent.click(screen.getByRole('button',{name:'保存设置'}));const oldEvent=api.subscribe.mock.calls[0][1]
  view.rerender(<ContextWorkspace sessionId="story" visible={false} client={api}/>);view.rerender(<ContextWorkspace sessionId="story" visible client={api}/>)
  await waitFor(()=>expect(screen.getByRole('button',{name:'保存设置'})).toBeEnabled())
  expect(screen.getByLabelText('保留完整正文轮数')).toHaveValue(9)
  const calls=api.state.mock.calls.length;await act(async()=>{oldEvent({type:'changed'});save.resolve(state())})
  expect(api.state.mock.calls.length).toBe(calls);expect(screen.getByLabelText('保留完整正文轮数')).toHaveValue(9)
})

it('preserves representation-only draft revision when an event brings newer history',async()=>{
  const api=client();render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  fireEvent.change(screen.getByLabelText('事实摘要'),{target:{value:'草稿摘要'}});api.set(state({revision:10}));await act(async()=>api.emit({type:'changed'}))
  expect(screen.getByRole('button',{name:'重新载入上下文'})).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('历史表示'),{target:{value:'summary'}});fireEvent.click(screen.getByRole('button',{name:'保存表示'}));await waitFor(()=>expect(api.represent).toHaveBeenCalled())
  expect(api.represent.mock.calls[0][1].expectedRevision).toBe(4)
  expect(api.represent.mock.calls[0][1].summary).toBe('草稿摘要')
})

it('never mounts a late original for a different selected record',async()=>{
  const second={...record,id:'h2',turn:2,action:'返回营地',source:{...record.source,assistantMessageId:'m2'}},api=client(state({history:[record,second]})),read=deferred();api.read.mockReturnValue(read.promise)
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边');fireEvent.click(screen.getByRole('button',{name:'展开原文'}))
  fireEvent.click(screen.getByRole('button',{name:/返回营地/}));await act(async()=>read.resolve({records:[record]}))
  expect(screen.queryByLabelText('历史原文')).not.toBeInTheDocument();expect(api.read.mock.calls[0][2].aborted).toBe(true)
})

it('uses session-scoped EventSource metadata and closes its connection',()=>{
  const listeners={},close=vi.fn(),received=vi.fn(),FakeSource=vi.fn(function(url){this.url=url;this.addEventListener=(name,fn)=>{listeners[name]=fn};this.close=close})
  vi.stubGlobal('EventSource',FakeSource)
  try{
    const dispose=createRpContextApi().subscribe('story',received,vi.fn());listeners.stage({data:JSON.stringify({sessionId:'elsewhere',step:2})});expect(received).not.toHaveBeenCalled()
    listeners.stage({data:JSON.stringify({sessionId:'story',step:2})});expect(received).toHaveBeenCalledWith({type:'stage',sessionId:'story',step:2})
    listeners.changed({data:'invalid'});expect(received).toHaveBeenCalledTimes(1);dispose();expect(close).toHaveBeenCalledOnce()
    expect(FakeSource.mock.calls[0][0].searchParams.get('sessionId')).toBe('story')
  }finally{vi.unstubAllGlobals()}
})

it('registers native context entry points and removes injected styles on disposal',async()=>{
  const native=await import('../../src/client.jsx'),disposers=[],registrations=[]
  const ctx={effect:fn=>{const dispose=fn();if(typeof dispose==='function')disposers.push(dispose)},sidebarRightTabs:{register:vi.fn(()=>vi.fn()),get:vi.fn(),subscribe:vi.fn(()=>vi.fn())},sidebarRight:{openTab:vi.fn()},slots:{inject:vi.fn((_name,fn)=>fn()),register:vi.fn((options,component)=>{registrations.push({options,component});return vi.fn()})}}
  native.apply(ctx)
  expect(native.inject).toEqual(['slots','sidebarRight','sidebarRightTabs']);expect(ctx.sidebarRightTabs.register.mock.calls[0][0]).toMatchObject({id:'dsh-rp-context/workspace',kind:'rp-context'})
  expect(document.querySelector('style[data-rp-context]')).toBeInTheDocument()
  for(const name of ['conversation.session.header.actions','conversation.hero.options','rp.studio.workspace.actions'])expect(registrations.some(item=>item.options.name===name)).toBe(true)
  const entry=registrations.find(item=>item.options.name==='conversation.session.header.actions');render(React.createElement(entry.component,entry.options.inject()))
  fireEvent.click(screen.getByRole('button',{name:'打开主动上下文'}));expect(ctx.sidebarRight.openTab).toHaveBeenCalledWith('rp-context')
  disposers.reverse().forEach(dispose=>dispose());expect(document.querySelector('style[data-rp-context]')).toBeNull()
})

it('keeps an inactive-record draft without showing its previous story content',async()=>{
  const api=client();render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  fireEvent.change(screen.getByLabelText('事实摘要'),{target:{value:'未保存的摘要'}})
  api.set(state({revision:5,history:[]}));await act(async()=>api.emit({type:'changed'}))
  expect(screen.queryByText('走到桥边')).not.toBeInTheDocument();expect(screen.queryByLabelText('历史原文')).not.toBeInTheDocument()
  api.set(state({revision:6}));await act(async()=>api.emit({type:'changed'}))
  expect(screen.getByLabelText('事实摘要')).toHaveValue('未保存的摘要')
})

it('removes rolled-back search summaries and references without rebasing unrelated drafts',async()=>{
  const retained={...record,id:'h2',anchor:'m2',turn:2,action:'留在营地',summary:'营地安全。',source:{...record.source,assistantMessageId:'m2',callId:'retained'}},api=client(state({history:[record,retained]}))
  api.search.mockResolvedValue({revision:4,matches:[{id:'h1',turn:1,mode:'summary',source:record.source,summary:'被回退的搜索摘要'}]})
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('留在营地')
  fireEvent.change(screen.getByLabelText('保留完整正文轮数'),{target:{value:'11'}});fireEvent.click(screen.getByRole('button',{name:/留在营地/}))
  fireEvent.change(screen.getByLabelText('事实摘要'),{target:{value:'营地的未保存草稿'}})
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索历史'}),{target:{value:'桥'}});fireEvent.click(screen.getByRole('button',{name:'搜索历史'}))
  expect(await screen.findByText('被回退的搜索摘要')).toBeInTheDocument()
  api.set(state({revision:5,history:[retained]}));await act(async()=>api.emit({type:'changed'}))
  const results=screen.queryByRole('region',{name:'搜索结果'})
  expect(screen.queryByText('被回退的搜索摘要')).not.toBeInTheDocument()
  expect(results&&within(results).queryByRole('button',{name:/查看第 1 轮/})).toBeNull()
  expect(results?.textContent??'').not.toContain('消息 m1')
  expect(screen.getByLabelText('保留完整正文轮数')).toHaveValue(11);expect(screen.getByLabelText('事实摘要')).toHaveValue('营地的未保存草稿')
  fireEvent.click(screen.getByRole('button',{name:'保存表示'}));await waitFor(()=>expect(api.represent).toHaveBeenCalled())
  expect(api.represent.mock.calls[0][1].expectedRevision).toBe(4)
})

it('does not reintroduce removed narratives when a pending search resolves after a branch update',async()=>{
  const api=client(),pending=deferred();api.search.mockReturnValue(pending.promise)
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  fireEvent.change(screen.getByLabelText('材料字符预算'),{target:{value:'33000'}})
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索历史'}),{target:{value:'桥'}});fireEvent.click(screen.getByRole('button',{name:'搜索历史'}))
  api.set(state({revision:5,history:[]}));await act(async()=>api.emit({type:'changed'}));expect(screen.getByText('尚无已确认的叙事')).toBeInTheDocument()
  await act(async()=>pending.resolve({revision:4,matches:[{id:'h1',turn:1,mode:'summary',summary:'迟到的已回退摘要',source:record.source}]}))
  expect(screen.queryByText('迟到的已回退摘要')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/查看第 1 轮/})).not.toBeInTheDocument()
  expect(screen.getByLabelText('材料字符预算')).toHaveValue(33000)
})

it('rejects old search sources even if the active history reuses their result id',async()=>{
  const api=client(),pending=deferred();api.search.mockReturnValue(pending.promise)
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边')
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索历史'}),{target:{value:'桥'}});fireEvent.click(screen.getByRole('button',{name:'搜索历史'}))
  api.set(state({revision:5,history:[{...record,anchor:'replacement',source:{...record.source,assistantMessageId:'replacement'}}]}));await act(async()=>api.emit({type:'changed'}))
  await act(async()=>pending.resolve({revision:4,matches:[{id:'h1',turn:1,mode:'summary',summary:'旧来源的搜索摘要',source:record.source}]}))
  expect(screen.queryByText('旧来源的搜索摘要')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/查看第 1 轮/})).not.toBeInTheDocument()
})

it('preserves author-note drafts through claims and version conflicts until explicit reload',async()=>{
  const note={id:'note',text:'已保存的作者注',version:1,status:'pending'},api=client(state({authorNote:note}))
  api.setAuthorNote=vi.fn().mockRejectedValue(Object.assign(new Error('作者注版本已变化'),{status:409}))
  render(<ContextWorkspace sessionId="story" visible client={api}/>);const input=await screen.findByLabelText('下次写作作者注')
  fireEvent.change(input,{target:{value:'未保存的新作者注'}})
  api.set(state({revision:7,authorNote:{...note,status:'claimed',claimedBy:'presentation'}}));await act(async()=>api.emit({type:'changed'}))
  expect(input).toHaveValue('未保存的新作者注');expect(screen.getByText(/已冻结供重试/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'保存作者注'}));await screen.findByRole('alert')
  expect(api.setAuthorNote.mock.calls[0].slice(0,3)).toEqual(['story','未保存的新作者注',4])
  expect(input).toHaveValue('未保存的新作者注')
  fireEvent.click(screen.getByRole('button',{name:'重新载入上下文'}));await waitFor(()=>expect(input).toHaveValue('已保存的作者注'))
})

it('reads exact frozen material for active presentations and discards late responses after adoption',async()=>{
  const active={...record,id:'["presentation",3]',source:{...record.source,presentationId:'presentation',baseResultSeq:3}},api=client(state({history:[active]})),pending=deferred()
  const snapshot={presentationId:'presentation',packet:{playerAction:'Frozen action'},contextPreparation:{materials:{history:[{id:active.id,mode:'summary',content:'冻结的摘要',source:active.source}],entries:[{id:'same',ref:{sourceKey:'alpha',entryId:'same'},content:'冻结的条目正文'}],guidance:'冻结的作者注',chars:123},database:{entryRefs:[{sourceKey:'alpha',entryId:'same',version:2}]}},compiled:{modules:[{name:'规则',text:'冻结的模块'}]},models:{writer:{provider:'local',model:'fixture'}},status:'complete'}
  api.material=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot)
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边');fireEvent.click(screen.getByRole('button',{name:'查看冻结材料'}))
  api.set(state({revision:5,history:[{...active,id:'["presentation",8]',text:'采用后的正文',summary:undefined,content:'采用后的正文',mode:'full',source:{...active.source,resultSeq:8}}],summaries:{}}));await act(async()=>api.emit({type:'changed'}))
  await act(async()=>pending.resolve(snapshot));expect(screen.queryByText('冻结的作者注')).not.toBeInTheDocument();expect(api.material.mock.calls[0][2].aborted).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'查看冻结材料'}));const material=await screen.findByRole('region',{name:'冻结写作材料'})
  expect(material).toHaveTextContent('冻结的条目正文');expect(material).toHaveTextContent('冻结的模块');expect(material).toHaveTextContent('123');expect(material).toHaveTextContent('alpha')
  expect(material).not.toHaveTextContent('思考过程')
})

it.each([true,false])('shows the captured history projection or explicitly marks an older receipt unrecorded (%s)',async recorded=>{
  const active={...record,source:{...record.source,presentationId:'presentation',baseResultSeq:3}},api=client(state({history:[active]}))
  api.material=vi.fn().mockResolvedValue({presentationId:'presentation',contextPreparation:{...(recorded?{historyProjection:{schemaVersion:1,projectionKey:'captured-basis-only',selectedPresentationIds:['old-selected'],activeFactReceiptIds:['old-fact-receipt']}}:{}),materials:{history:[],entries:[],guidance:'',chars:0}}})
  render(<ContextWorkspace sessionId="story" visible client={api}/>);await screen.findByText('走到桥边');fireEvent.click(screen.getByRole('button',{name:'查看冻结材料'}))
  const material=await screen.findByRole('region',{name:'冻结写作材料'}),projection=within(material).getByText('当时的有效历史投影').parentElement
  expect(projection).toHaveTextContent(recorded?'captured-basis-only':'未记录')
  if(recorded){expect(projection).toHaveTextContent('old-selected');expect(projection).toHaveTextContent('old-fact-receipt')}
})

it('shows unavailable effective history while keeping settings and pending owner note controls usable',async()=>{
  const api=client(state({history:[],historyError:{code:'EFFECTIVE_HISTORY_UNAVAILABLE',message:'Required effective reader is unavailable'},authorNote:{id:'note',text:'Pending owner note',version:1,status:'pending'}}))
  api.setAuthorNote=vi.fn().mockResolvedValue({revision:5})
  render(<ContextWorkspace sessionId="story" visible client={api}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Required effective reader is unavailable')
  expect(screen.queryByText('尚无已确认的叙事')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'搜索历史'})).toBeDisabled()
  fireEvent.change(screen.getByLabelText('保留完整正文轮数'),{target:{value:'7'}});fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await waitFor(()=>expect(api.configure).toHaveBeenCalled())
  const note=screen.getByLabelText('下次写作作者注');expect(note).toHaveValue('Pending owner note');fireEvent.change(note,{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'保存作者注'}))
  await waitFor(()=>expect(api.setAuthorNote).toHaveBeenCalled());expect(api.setAuthorNote.mock.calls[0][1]).toBe('')
})
