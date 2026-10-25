import React from 'react'
import {ContextWorkspace,ContextIcon} from './ContextWorkspace.jsx'
import css from './styles.css'

export const inject=['slots','sidebarRight','sidebarRightTabs']
export const TAB_ID='dsh-rp-context/workspace'
export const TAB_KIND='rp-context'
function OpenButton({open}){return <button type="button" className="rpc-open-entry" aria-label="打开主动上下文" title="主动上下文" onClick={open}><ContextIcon/><span>上下文</span></button>}
export function apply(ctx){
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.rpContext='';style.textContent=css;document.head.append(style);return()=>style.remove()},'RP context styles')
  function Body({sessionId,useTabInfo}){const {tab}=useTabInfo();return <ContextWorkspace key={sessionId} sessionId={sessionId} visible={tab.visible}/>}
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:TAB_ID,kind:TAB_KIND,title:()=> '主动上下文',guide:[{id:TAB_KIND,order:39,title:()=> '主动上下文',description:()=> '正式叙事、材料表示与原文'}]}),'RP context tab')
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TAB_ID},Body)),'RP context pane')
  for(const name of ['conversation.session.header.actions','conversation.hero.options','rp.studio.workspace.actions'])ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,id:TAB_ID,order:39,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND)})},OpenButton)),`RP context entry ${name}`)
}
