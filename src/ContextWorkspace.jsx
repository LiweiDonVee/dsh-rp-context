import React,{useEffect,useRef,useState} from 'react'
import {createRpContextApi} from './api.js'

const api=createRpContextApi()
const modes={full:'完整正文',summary:'事实摘要',index:'仅索引'}
const defaults={enabled:true,recentTurns:5,maxChars:24000,maxSteps:8}
const summaryOf=(record,data)=>data.representations?.[record.id]?.summary??data.summaries?.[record.id]??record.summary??''
const sourceLabel=source=>[source?.sessionId&&`会话 ${source.sessionId}`,source?.assistantMessageId&&`消息 ${source.assistantMessageId}`,source?.callSeq!==undefined&&`调用 ${source.callSeq}`,source?.resultSeq!==undefined&&`结果 ${source.resultSeq}`,source?.callId&&`引用 ${source.callId}`].filter(Boolean).join(' · ')
const historyReference=record=>JSON.stringify([record.id,record.source?.sessionId,record.source?.assistantMessageId,record.source?.callSeq,record.source?.resultSeq,record.source?.callId])

export function ContextIcon(){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>}

function Original({client,sessionId,record,signal}){
  const [result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const request=useRef(null)
  useEffect(()=>()=>request.current?.abort(),[])
  async function read(){
    request.current?.abort();const controller=new AbortController();request.current=controller
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort()
    setBusy(true);setError('')
    try{const data=await client.read(sessionId,[record.id],controller.signal);if(!controller.signal.aborted){const found=data.records.find(item=>item.id===record.id);if(found)setResult(found);else setError('该叙事已不在当前故事分支中。')}}
    catch(cause){if(!controller.signal.aborted)setError(cause.message)}
    finally{signal.removeEventListener('abort',abort);if(!controller.signal.aborted)setBusy(false)}
  }
  return <div className="rpc-original"><button type="button" disabled={busy} onClick={()=>result?setResult(null):void read()}>{busy?'读取原文…':result?'收起原文':'展开原文'}</button>{error&&<p role="alert">{error}</p>}{result&&<section aria-label="历史原文"><p className="rpc-source">{sourceLabel(result.source)}</p><pre>{result.text}</pre></section>}</div>
}

export function ContextWorkspace({sessionId,visible=true,client=api}){
  if(!sessionId)return <div className="rpc-workspace"><h1>主动上下文</h1><p className="rpc-empty">请先打开一个故事会话</p></div>
  return <Workspace key={sessionId} sessionId={sessionId} visible={visible} client={client}/>
}

function Workspace({sessionId,visible,client}){
  const [data,setData]=useState(null),[settings,setSettings]=useState(null),[drafts,setDrafts]=useState({}),[selected,setSelected]=useState(null)
  const [error,setError]=useState(''),[conflict,setConflict]=useState(false),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[notice,setNotice]=useState(''),[stage,setStage]=useState('')
  const [query,setQuery]=useState(''),[matches,setMatches]=useState(null),[searching,setSearching]=useState(false)
  const lifecycle=useRef(null),loadRef=useRef(null),searchSeq=useRef(0),activeHistory=useRef(new Set())
  useEffect(()=>{
    if(!visible)return
    const controller=new AbortController();lifecycle.current=controller;let sequence=0
    setSaving(false);setSearching(false);setStage('')
    async function load(force=false){
      const seq=++sequence
      try{
        const next=await client.state(sessionId,controller.signal)
        if(controller.signal.aborted||seq!==sequence)return
        activeHistory.current=new Set(next.history.map(historyReference))
        setMatches(previous=>previous===null?null:previous.filter(match=>activeHistory.current.has(historyReference(match))))
        setData(next);setLoading(false);setError('')
        setSettings(previous=>!force&&previous?.dirty?previous:{value:{...defaults,...next.settings},revision:next.revision,dirty:false})
        setDrafts(previous=>({
          ...(!force?Object.fromEntries(Object.entries(previous).filter(([,draft])=>draft.dirty)):{}),
          ...Object.fromEntries(next.history.map(record=>[record.id,!force&&previous[record.id]?.dirty?previous[record.id]:{mode:record.mode,summary:summaryOf(record,next),revision:next.revision,dirty:false}])),
        }))
        setSelected(previous=>next.history.some(item=>item.id===previous)?previous:next.history[0]?.id??null)
        if(force){setConflict(false);setNotice('已重新载入上下文');setMatches(null)}
      }catch(cause){if(!controller.signal.aborted&&seq===sequence){setError(cause.message);setLoading(false)}}
    }
    loadRef.current=load;void load()
    const close=client.subscribe(sessionId,event=>{
      if(controller.signal.aborted)return
      if(event.type==='stage'){
        const done=['complete','failed','cancelled','rendered'].includes(event.status)
        setStage(done?'':`正在准备本轮材料${event.step?` · 第 ${event.step} 步`:''}`)
        if(done)void load()
      }else void load()
    },()=>{if(!controller.signal.aborted)setStage('连接已中断，正在重新同步')})
    return()=>{controller.abort();close();if(lifecycle.current===controller){lifecycle.current=null;loadRef.current=null}}
  },[sessionId,visible,client])
  const record=data?.history.find(item=>item.id===selected),draft=drafts[selected]
  function editSetting(key,value){setNotice('');setSettings(previous=>({...previous,value:{...previous.value,[key]:value},dirty:true}))}
  function editRepresentation(key,value){setNotice('');setDrafts(previous=>({...previous,[selected]:{...previous[selected],[key]:value,dirty:true}}))}
  async function write(kind){
    const controller=lifecycle.current;if(!controller||saving)return
    setError('');setNotice('')
    const input=kind==='settings'?settings:draft
    if(kind==='representation'&&input.mode==='summary'&&!input.summary.trim()){setError('请填写事实摘要，或等待下次最终呈现自动生成。');return}
    setSaving(true)
    try{
      if(kind==='settings')await client.configure(sessionId,input.value,input.revision,controller.signal)
      else await client.represent(sessionId,{historyId:selected,mode:input.mode,...(input.mode==='summary'?{summary:input.summary.trim()}:{}),expectedRevision:input.revision},controller.signal)
      if(controller.signal.aborted||lifecycle.current!==controller)return
      if(kind==='settings')setSettings(previous=>({...previous,dirty:false}))
      else setDrafts(previous=>({...previous,[selected]:{...previous[selected],dirty:false}}))
      setConflict(false);setNotice(kind==='settings'?'设置已保存':'历史表示已保存');await loadRef.current?.()
    }catch(cause){if(!controller.signal.aborted&&lifecycle.current===controller){setError(cause.message);if(cause.status===409)setConflict(true)}}
    finally{if(!controller.signal.aborted&&lifecycle.current===controller)setSaving(false)}
  }
  async function search(event){
    event.preventDefault();const controller=lifecycle.current;if(!controller)return
    const seq=++searchSeq.current;setSearching(true);setError('')
    try{const result=await client.search(sessionId,query,controller.signal);if(!controller.signal.aborted&&lifecycle.current===controller&&seq===searchSeq.current)setMatches(result.matches.filter(match=>activeHistory.current.has(historyReference(match))))}
    catch(cause){if(!controller.signal.aborted&&lifecycle.current===controller&&seq===searchSeq.current)setError(cause.message)}
    finally{if(!controller.signal.aborted&&lifecycle.current===controller&&seq===searchSeq.current)setSearching(false)}
  }
  const staleDraft=data&&(settings?.dirty&&settings.revision!==data.revision||Object.values(drafts).some(item=>item.dirty&&item.revision!==data.revision))
  if(!visible)return null
  return <main className="rpc-workspace" data-rp-context-root={sessionId}>
    <header className="rpc-header"><div><h1><ContextIcon/>主动上下文</h1><p>查看本轮材料，保留故事原文。</p></div><button type="button" disabled={loading||saving} onClick={()=>void loadRef.current?.()}>刷新</button></header>
    <p className="rpc-scope">当前窗口用于中间 GM 选材与最终写作输入。DSH 主 Agent 的历史和日志仍然保留；原生与 ACP 的上下文压缩由宿主管理。</p>
    {stage&&<p role="status" className="rpc-status">{stage}</p>}{notice&&<p role="status" className="rpc-status">{notice}</p>}
    {error&&<p role="alert" className="rpc-error">{error}</p>}
    {(conflict||staleDraft)&&<div className="rpc-conflict"><p>{conflict?'上下文已变化，输入已保留。重新载入将放弃当前未保存的编辑。':'有未保存的编辑。后台更新不会改变草稿的起始版本。重新载入将放弃当前编辑。'}</p><button type="button" disabled={saving} onClick={()=>void loadRef.current?.(true)}>重新载入上下文</button></div>}
    {loading&&!data&&<p role="status">正在读取上下文…</p>}
    {settings&&<section className="rpc-panel" aria-label="上下文设置"><h2>本轮材料设置</h2><form onSubmit={event=>{event.preventDefault();void write('settings')}}>
      <label className="rpc-check"><input type="checkbox" checked={settings.value.enabled} disabled={saving} onChange={event=>editSetting('enabled',event.target.checked)}/>启用主动上下文</label>
      <div className="rpc-fields">{[['recentTurns','保留完整正文轮数',1000],['maxChars','材料字符预算',1000000],['maxSteps','GM 最大步骤',32]].map(([key,label,max])=><label key={key}>{label}<input type="number" min="1" max={max} required value={settings.value[key]} disabled={saving} onChange={event=>editSetting(key,event.target.value===''?'':Number(event.target.value))}/></label>)}</div>
      <p className="rpc-help">轮数按已确认的正式叙事计算，不按工具消息计数。更早的正文默认使用事实摘要；缺少摘要时，在下次最终呈现前自动生成。查看与保存设置不会调用模型。</p>
      <button type="submit" disabled={saving||!settings.dirty}>{saving?'正在保存…':'保存设置'}</button>
    </form></section>}
    {data&&<>
      <section className="rpc-panel" aria-label="正式叙事历史"><div className="rpc-section-head"><h2>正式叙事历史</h2><span>{data.history.length} 条</span></div><p className="rpc-help">选择材料表示只影响后续输入；原文保持不变。</p>
        <form className="rpc-search" onSubmit={search}><label><span className="rpc-sr">搜索历史</span><input type="search" aria-label="搜索历史" value={query} placeholder="搜索当前故事的正式叙事" onChange={event=>setQuery(event.target.value)}/></label><button type="submit" disabled={searching||!query.trim()}>{searching?'搜索中…':'搜索历史'}</button></form>
        {matches!==null&&<section className="rpc-results" aria-label="搜索结果"><h3>搜索结果</h3>{matches.length?matches.map(match=><div key={match.id}><button type="button" onClick={()=>setSelected(match.id)}>查看第 {match.turn} 轮 · {modes[match.mode]??'历史'}</button>{match.summary&&<p>{match.summary}</p>}<p className="rpc-source">{sourceLabel(match.source)}</p></div>):<p>没有匹配的正式叙事</p>}</section>}
        {!data.history.length?<p className="rpc-empty">尚无已确认的叙事</p>:<div className="rpc-history-layout"><div className="rpc-history-list" role="list" aria-label="叙事回合">{data.history.map(item=><div role="listitem" key={item.id}><button className="rpc-history-item" type="button" aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}><span className="rpc-item-meta">第 {item.turn} 轮 <span className="rpc-badge">{modes[item.mode]}</span></span><strong>{item.action||'正式正文'}</strong><span className="rpc-preview">{summaryOf(item,data)||'未生成摘要'}</span><span className="rpc-source">{sourceLabel(item.source)}</span></button></div>)}</div>
        {record&&draft&&<section className="rpc-inspector" aria-label="叙事材料详情"><h3>第 {record.turn} 轮的材料</h3><div className="rpc-material"><span className="rpc-badge">{modes[record.mode]}</span><p>{record.mode==='summary'?(summaryOf(record,data)||'未生成摘要'):record.mode==='index'?'仅保留轮数与来源引用，需要时可展开原文。':record.content}</p></div>
          <label>历史表示<select aria-label="历史表示" value={draft.mode} disabled={saving} onChange={event=>editRepresentation('mode',event.target.value)}>{Object.entries(modes).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          <label>事实摘要<textarea aria-label="事实摘要" rows="5" value={draft.summary} disabled={saving||draft.mode!=='summary'} placeholder="只记录已确认的事实，不把提案当作已发生事件" onChange={event=>editRepresentation('summary',event.target.value)}/></label>
          <p className="rpc-help">选择事实摘要时需有实际内容。未决事项在下方单独列出。</p><button type="button" disabled={saving||!draft.dirty} onClick={()=>void write('representation')}>保存表示</button>
          {lifecycle.current&&<Original key={selected} client={client} sessionId={sessionId} record={record} signal={lifecycle.current.signal}/>}
        </section>}</div>}
      </section>
      <section className="rpc-panel" aria-label="未决事项"><h2>未决事项</h2><p className="rpc-help">尚未确定的问题单独保留，不作为已经发生的事件。</p>{data.unresolved?.length?<ul>{data.unresolved.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p className="rpc-empty">暂无未决事项</p>}</section>
    </>}
  </main>
}
