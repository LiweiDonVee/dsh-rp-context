export function createRpContextApi(send = (...args) => globalThis.fetch(...args)) {
  async function request(action, input, signal) {
    const response = await send(new URL('api/rp-context/request', document.baseURI), {
      method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({action,...input}),
    })
    let data
    try { data = await response.json() }
    catch { throw Object.assign(new Error('无法读取上下文响应，请重试。'),{status:response.status}) }
    if (!response.ok || data?.error) throw Object.assign(new Error(data?.error?.message || '上下文请求失败，请重试。'),{status:response.status,code:data?.error?.code})
    if (action === 'authorNote' && data === null) return null
    if (!data || typeof data !== 'object') throw new Error('上下文响应不完整，请重新载入。')
    return data
  }
  return {
    state:(sessionId,signal)=>request('state',{sessionId},signal),
    configure:(sessionId,settings,expectedRevision,signal)=>request('configure',{sessionId,settings,expectedRevision},signal),
    read:(sessionId,historyIds,signal)=>request('read',{sessionId,historyIds},signal),
    search:(sessionId,query,signal)=>request('search',{sessionId,query},signal),
    represent:(sessionId,input,signal)=>request('represent',{sessionId,...input},signal),
    authorNote:(sessionId,signal)=>request('authorNote',{sessionId},signal),
    setAuthorNote:(sessionId,text,expectedRevision,signal)=>request('setAuthorNote',{sessionId,text,expectedRevision},signal),
    material:(sessionId,presentationId,signal)=>request('material',{sessionId,presentationId},signal),
    subscribe(sessionId,onEvent,onError) {
      const url=new URL('api/rp-context/events',document.baseURI);url.searchParams.set('sessionId',sessionId)
      const source=new EventSource(url)
      for(const type of ['connected','changed','stage'])source.addEventListener(type,event=>{
        let data;try{data=JSON.parse(event.data)}catch{return}
        if(data?.sessionId===sessionId)onEvent({...data,type})
      })
      source.onerror=onError
      return()=>source.close()
    },
  }
}
