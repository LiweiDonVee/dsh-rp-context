import test from 'node:test'
import assert from 'node:assert/strict'

test('context owner routes validate exact session settings and source representation operations',async()=>{
  const module=await import('../src/routes.mjs').catch(()=>({}));assert.equal(typeof module.createContextRoutes,'function')
  let calls=0
  const routes=module.createContextRoutes({state:async()=>{calls++;return{revision:0,history:[]}}})
  const req=body=>new Request('http://localhost/api/rp-context/request',{method:'POST',body:JSON.stringify(body)})
  assert.equal((await routes.request(req({action:'state',sessionId:'s',url:'https://example.com'}))).status,400)
  assert.equal((await routes.request(req({action:'state',sessionId:'s'}))).status,200)
  assert.equal((await routes.request(req({action:'configure',sessionId:'s',settings:{recentTurns:2}}))).status,400)
  assert.equal(calls,1)
})
