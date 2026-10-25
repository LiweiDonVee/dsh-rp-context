// Owner-only native restore/preflight checks; never resume an Agent or request a model.
export const name = 'context-restore-preflight-probe'
export const inject = ['connection', 'typertGateway', 'agents', 'llm', 'sessionPersistence', 'sessionQuery']

export function apply(ctx) {
  let modelCalls = 0
  ctx.llm.registerAdapter(['context-preflight-local'], {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_provider, _model, value) => value,
    listModels: async provider => [{ provider, id: 'main', name: 'No-call preflight fixture' }],
    resolveModel: async (provider, id) => ({ provider, id, name: id }),
    async prepareCall(provider, id) { return { model: await this.resolveModel(provider, id), stream: options => this.stream(options) } },
    stream() { modelCalls++;throw Error('Restore/preflight must not request models') },
  })
  async function observed(id) {
    const view = await ctx.sessionQuery.observeSession(id)
    try { return { header: view.header, events: view.events, inheritedEventCount: view.inheritedEventCount, live: !!ctx.agents.get(id) } }
    finally { view[Symbol.dispose]() }
  }
  ctx.connection.fetch.register({ path: '/api/context-restore-preflight', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      const input = await request.json(), signal = request.signal, context = ctx.get('rpContext'), last = ctx.get('rpLastStep')
      const snapshot = input.snapshot, sessionIds = snapshot.sessions.map(item => item.header.id), state = snapshot.pluginState.context
      if (input.action === 'import') {
        for (const session of snapshot.sessions) {
          const handle = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
          try { await handle.append(session.events);await handle.flush() } finally { await handle.close() }
        }
        const canonical = await Promise.all(sessionIds.map(observed))
        const initial = await context.preflightRestore({ sessionIds, state, signal })
        const lastStep = await last.restoreState({ restoreId: input.restoreId, sessionIds, state: snapshot.pluginState.lastStep, expectedRevision: (await last.contentRevision()).revision, signal })
        const restored = await context.restoreState({ restoreId: input.restoreId, sessionIds, state, expectedRevision: (await context.contentRevision()).revision, signal })
        return Response.json({ ok: true, initial, lastStep, restored, canonical, modelCalls })
      }
      if (input.action === 'inspect') {
        const revision = await context.contentRevision(), preflight = await context.preflightRestore({ sessionIds, state, signal })
        const afterPreflight = await context.contentRevision(), actual = await context.exportState({ sessionIds, signal })
        const canonical = await Promise.all(sessionIds.map(observed))
        const proofs = []
        for (const item of state.payload.sessions) for (const [claimId, claim] of Object.entries(item.state.noteClaims)) if (claim.status === 'consumed') {
          const material = await last.material({ sessionId: item.sessionId, presentationId: claim.outcomePresentationId, signal })
          proofs.push({ sessionId: item.sessionId, presentationId: material.presentationId, claimId, authorNote: material.contextPreparation?.authorNote })
        }
        return Response.json({ ok: true, revision, afterPreflight, preflight, actual, canonical, proofs, modelCalls })
      }
      if (input.action === 'edit') {
        const edited = await context.setAuthorNote({ sessionId: sessionIds[0], text: 'Later destination owner direction', expectedRevision: (await context.contentRevision()).revision, signal })
        return Response.json({ ok: true, edited, modelCalls })
      }
      if (input.action === 'replay') {
        const before = await context.exportState({ sessionIds, signal })
        const restored = await context.restoreState({ restoreId: input.restoreId, sessionIds, state, expectedRevision: before.revision, signal })
        const after = await context.exportState({ sessionIds, signal })
        return Response.json({ ok: true, before, restored, after, modelCalls })
      }
      return Response.json({ ok: false, error: { code: 'INVALID_FIXTURE_ACTION' } }, { status: 400 })
    } catch (error) { return Response.json({ ok: false, error: { code: error.code ?? 'RESTORE_PREFLIGHT_FIXTURE_ERROR', message: error.message } }) }
  } })
}
