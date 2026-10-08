import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Subagent from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ProductionStudio, { decodeProductionState } from '../src/index.ts'
import type { NativeReconciliationRequest, NativeReconciliationResult, ProductionEvidence } from '../src/types.ts'

const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(maxEvidenceBytes = 262144) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-reconcile-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FsLocal, { cwd: root }); await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(root, 'state') })
  await ctx.plugin(StorageDomain, { backend: 'json' }); await ctx.plugin(Subagent); await ctx.plugin(Fork)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const kv = ctx.storage.backend.get('json').kv!
  const open = kv.open.bind(kv)
  let unit: KvUnit | undefined
  vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => { const opened = await open(descriptor); if (descriptor.name === 'production_studio') unit = opened; return opened })
  const driver = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([toolCallResponse('native-original', 'try_suggestion', { caseId: 'case-original', revision: 12 }), textResponse('Preserved the rejection receipt')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('native-owner'), { provider: 'mock', model: 'mock' }, { cwd: root })
  let fiber = await ctx.plugin(ProductionStudio, { maxEvidenceBytes })
  const bind = () => {
    ctx.productionStudio.registerConversationWorkflow({ id: 'fixture', toolNames: ['try_suggestion'], appliesTo: current => current.id === agent.id,
      start: () => ({ key: 'case-original', objective: 'Recover the exact invocation', input: { caseId: 'case-original' } }), observe: () => undefined })
    ctx.productionStudio.registerNativeBoundaryProvider(['try_suggestion'])
  }
  bind()
  let calls = 0
  ctx.tools.register(defineTool({ name: 'try_suggestion', description: 'Native provider fixture', parameters: { caseId: { type: 'string' }, revision: { type: 'number' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, exec) => { calls++; await ctx.productionStudio.noteNativeDispatch(exec.callId); throw new Error('Duplicate operation ID') } }))
  const run = async () => { const value = (await ctx.productionStudio.get(agent.id)).runs.at(-1); if (!value) throw new Error('No run'); return value }
  const ref = async () => { const value = await run(); return { runId: value.id, revision: value.revision, nodeId: 'baseline' } }
  const start = async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try the original suggestion' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const resolver = vi.fn(async (request: NativeReconciliationRequest): Promise<NativeReconciliationResult> => ({
    sessionId: request.sessionId, operationId: request.operationId, toolName: request.toolName, argumentSha256: request.argumentSha256,
    outcome: 'rejected_before_native', receipt: { nativeEntered: false, code: 'duplicate_operation' }, evidence: { ledgerSha256: 'a'.repeat(64), workflowRevision: 12 },
  }))
  const register = (id = 'host-fixture') => ctx.productionStudio.registerNativeReconciliationProvider({ id, toolNames: ['try_suggestion'], reconcile: resolver })
  const reconcile = async () => ctx.productionStudio.reconcile(agent.id, await ref())
  const reload = async () => { await fiber.dispose(); fiber = await ctx.plugin(ProductionStudio, { maxEvidenceBytes }); bind() }
  const durable = async (): Promise<{ tables: { native: Record<string, unknown> } }> => JSON.parse(await readFile(join(root, 'state/production_studio.json'), 'utf8')) as { tables: { native: Record<string, unknown> } }
  // Exercise admission of the historical, already oversized representation from
  // a temporary persisted domain. No production data or private runtime is used.
  const legacyEvidence = async (evidence: ProductionEvidence) => {
    await fiber.dispose()
    const path = join(root, 'state/production_studio.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { tables: { sessions: Record<string, unknown>; evidence?: Record<string, unknown> } }
    const state = decodeProductionState(saved.tables.sessions[agent.id])
    state.runs[0]!.tasks[0]!.evidence = [evidence]
    saved.tables.sessions[agent.id] = state
    delete saved.tables.evidence
    await writeFile(path, JSON.stringify(saved))
    fiber = await ctx.plugin(ProductionStudio, { maxEvidenceBytes }); bind()
  }
  return { ctx, agent, adapter, root, start, run, ref, resolver, register, reconcile, reload, durable,
    legacyEvidence, calls: () => calls, unit: () => unit! }
}

const largeDiagnostic = (): ProductionEvidence => ({ kind: 'tool', nodeId: 'baseline', attempt: 1,
  toolName: 'compare_candidates', data: { diagnostics: '诊断'.repeat(47000), candidates: [{ cost: 12.3, selected: true }] }, observedAt: 1720000000000 })

describe('exact native invocation reconciliation', () => {
  it('archives historical oversized diagnostic bytes before settling and restores them after restart without resetting budgets', async () => {
    const h = await harness(); await h.start()
    const original = largeDiagnostic(); await h.legacyEvidence(original); h.register()
    const before = await h.run()
    expect(Buffer.byteLength(JSON.stringify(before.tasks[0]!.evidence))).toBeGreaterThan(262144)
    const after = (await h.reconcile()).runs[0]!
    const retained = after.tasks[0]!.evidence[0]!
    expect(retained.data).toHaveProperty('productionEvidenceReference')
    expect(Buffer.byteLength(JSON.stringify(after.tasks[0]!.evidence))).toBeLessThanOrEqual(262144)
    expect(after.phase).toBe('paused'); expect(after.executions).toBe(before.executions)
    expect(after.tasks[0]!.attempts).toBe(before.tasks[0]!.attempts); expect(after.tasks[0]!.certificates).toEqual([])
    expect(await h.ctx.productionStudio.readEvidence(h.agent.id, retained)).toEqual(original)
    await h.reload()
    expect(await h.ctx.productionStudio.readEvidence(h.agent.id, retained)).toEqual(original)
    expect((await h.durable()).tables.native).toEqual({}); expect(h.calls()).toBe(1)
    const paused = await h.run(), request = { requestId: 'f06bcb98-11f6-46d7-b1c6-13c9c9303d14', text: 'Use the exact retained result and continue.' }
    const steer = vi.spyOn(h.agent, 'steer')
    await h.ctx.productionStudio.resume(h.agent.id, await h.ref(), request); await h.agent.whenIdle()
    expect(steer).toHaveBeenCalledTimes(1); expect((await h.run()).executions).toBe(paused.executions)
    expect(h.calls()).toBe(1)
  })

  it('keeps the unknown lease and complete old evidence when archival durability fails', async () => {
    const h = await harness(); await h.start(); const original = largeDiagnostic(); await h.legacyEvidence(original); h.register()
    const unit = h.unit(), put = unit.putRecord.bind(unit)
    vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
      if (table === 'evidence') throw new Error('Archive storage outage')
      return put(table, key, value)
    })
    await expect(h.reconcile()).rejects.toThrow('Archive storage outage')
    expect((await h.run()).tasks[0]!.evidence).toEqual([original])
    expect((await h.run()).phase).toBe('unknown')
    expect((await h.durable()).tables.native['Rhino']).not.toHaveProperty('settlement')
    expect(h.calls()).toBe(1)
  })

  it.each(['missing', 'tampered'] as const)('retains the prepared lease when an archived observation is %s on restart', async (damage) => {
    const h = await harness(); await h.start(); await h.legacyEvidence(largeDiagnostic()); h.register()
    const unit = h.unit()
    vi.spyOn(unit, 'deleteRecord').mockRejectedValueOnce(new Error('Hold the prepared native lease'))
    await expect(h.reconcile()).rejects.toThrow('Hold the prepared native lease')
    const path = join(h.root, 'state/production_studio.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { tables: { evidence: Record<string, { sessionId: string; text: string }> } }
    const [key, value] = Object.entries(saved.tables.evidence)[0]!
    if (damage === 'missing') await unit.deleteRecord('evidence', key)
    else await unit.putRecord('evidence', key, { ...value, text: value.text.replace('诊断', '篡改') })
    await h.reload()
    await expect(h.reconcile()).rejects.toThrow('missing or its byte identity changed')
    expect((await h.durable()).tables.native['Rhino']).toHaveProperty('settlement')
    expect(h.calls()).toBe(1)
  })

  it('rejects changed observation identity and foreign Session references on exact readback', async () => {
    const h = await harness(); await h.start(); await h.legacyEvidence(largeDiagnostic()); h.register()
    const retained = (await h.reconcile()).runs[0]!.tasks[0]!.evidence[0]!
    await expect(h.ctx.productionStudio.readEvidence(h.agent.id, { ...retained, attempt: 2 })).rejects.toThrow('observation identity changed')
    const data = retained.data as { productionEvidenceReference: { sessionId: string } }
    data.productionEvidenceReference.sessionId = 'another-session'
    await expect(h.ctx.productionStudio.readEvidence(h.agent.id, retained)).rejects.toThrow('another Session')
  })

  it.each(['objective', 'human', 'file'] as const)('does not archive oversized %s evidence to admit reconciliation', async (kind) => {
    const h = await harness(); await h.start()
    const evidence = largeDiagnostic()
    if (kind === 'objective') evidence.toolName = 'production_aea_evidence'
    else evidence.kind = kind
    await h.legacyEvidence(evidence); h.register()
    await expect(h.reconcile()).rejects.toThrow('retained byte limit')
    expect((await h.run()).tasks[0]!.evidence).toEqual([evidence])
    expect((await h.durable()).tables.native['Rhino']).not.toHaveProperty('settlement')
  })

  it('binds original raw arguments and settledOperationId, stores rejection and pauses without replay or budget reset', async () => {
    const h = await harness(); await h.start(); h.register()
    const before = await h.run()
    expect(before.phase).toBe('unknown')
    expect(before.tasks[0]?.operationId).toBeUndefined()
    expect(before.tasks[0]?.settledOperationId).toBe('native-original')
    const after = (await h.reconcile()).runs[0]!
    const request = h.resolver.mock.calls[0]![0]
    expect(request.argumentSha256).toBe(createHash('sha256').update(request.callEvent.data.arguments).digest('hex'))
    expect(request.arguments).toEqual({ caseId: 'case-original', revision: 12 })
    expect(request.resultEvent?.data.message.isError).toBe(true)
    expect(after.phase).toBe('paused'); expect(after.tasks[0]?.phase).toBe('paused')
    expect(after.executions).toBe(before.executions); expect(after.tasks[0]?.attempts).toBe(before.tasks[0]?.attempts)
    expect(after.tasks[0]?.certificates).toEqual([])
    expect(after.tasks[0]?.evidence.at(-1)?.data).toMatchObject({ nativeReconciliation: { result: { outcome: 'rejected_before_native' } } })
    expect((await h.durable()).tables.native).toEqual({}); expect(h.calls()).toBe(1)
    await h.ctx.productionStudio.resume(h.agent.id, await h.ref())
    await h.agent.whenIdle()
    expect((await h.run()).executions).toBe(before.executions); expect(h.calls()).toBe(1)
  })

  it.each(['operationId', 'toolName', 'argumentSha256', 'sessionId'] as const)('refuses a Host receipt for another %s', async (field) => {
    const h = await harness(); await h.start(); h.register()
    const original = h.resolver.getMockImplementation()!
    h.resolver.mockImplementation(async request => ({ ...await original(request), [field]: field === 'argumentSha256' ? 'b'.repeat(64) : 'different' }))
    await expect(h.reconcile()).rejects.toThrow('identity does not match')
    expect((await h.run()).phase).toBe('unknown'); expect((await h.durable()).tables.native['Rhino']).toBeDefined()
  })

  it('refuses stale revisions, missing or conflicting providers, and retains a genuine unknown outcome', async () => {
    const h = await harness(); await h.start()
    await expect(h.reconcile()).rejects.toThrow('No Host provider')
    const dispose = h.register(), conflict = h.register('other')
    await expect(h.reconcile()).rejects.toThrow('More than one')
    conflict()
    const ref = await h.ref()
    await expect(h.ctx.productionStudio.reconcile(h.agent.id, { ...ref, revision: ref.revision - 1 })).rejects.toThrow('changed')
    const original = h.resolver.getMockImplementation()!
    h.resolver.mockImplementation(async request => ({ ...await original(request), outcome: 'unknown' }))
    expect((await h.reconcile()).runs[0]?.phase).toBe('unknown')
    dispose(); await expect(h.reconcile()).rejects.toThrow('No Host provider')
    expect(h.calls()).toBe(1)
  })

  it('removes the provider when its plugin effect is disposed', async () => {
    const h = await harness(); await h.start()
    const fiber = await h.ctx.plugin((ctx: Context) => { ctx.effect(() => h.register()) })
    await fiber.dispose()
    await expect(h.reconcile()).rejects.toThrow('No Host provider')
    expect(h.resolver).not.toHaveBeenCalled()
  })

  it('rechecks original events after awaiting the Host resolver', async () => {
    const h = await harness(); await h.start(); h.register()
    const original = h.resolver.getMockImplementation()!
    h.resolver.mockImplementation(async (request) => {
      h.agent.session.append('tool/call', request.callEvent.data)
      return original(request)
    })
    await expect(h.reconcile()).rejects.toThrow('duplicated or mismatched')
    expect((await h.run()).phase).toBe('unknown')
    expect((await h.durable()).tables.native['Rhino']).not.toHaveProperty('settlement')
  })

  it('retains quarantine when another matching provider registers while reconciliation is in flight', async () => {
    const h = await harness(); await h.start(); h.register()
    const original = h.resolver.getMockImplementation()!
    h.resolver.mockImplementation(async (request) => {
      h.register('overlapping-provider')
      return original(request)
    })
    await expect(h.reconcile()).rejects.toThrow('provider changed')
    expect((await h.run()).phase).toBe('unknown')
    expect((await h.durable()).tables.native['Rhino']).not.toHaveProperty('settlement')
  })

  it('selects only the provider that owns the exact Session when another preset uses the same tools', async () => {
    const h = await harness(); await h.start(); h.register()
    const wrong = vi.fn(async (request: NativeReconciliationRequest) => h.resolver(request))
    h.ctx.productionStudio.registerNativeReconciliationProvider({ id: 'other-preset', toolNames: ['try_suggestion'],
      appliesTo: sessionId => sessionId !== h.agent.id, reconcile: wrong })
    expect((await h.reconcile()).runs[0]?.phase).toBe('paused')
    expect(wrong).not.toHaveBeenCalled(); expect(h.resolver).toHaveBeenCalledTimes(1)
  })

  it('refuses duplicated Session invocation identities', async () => {
    const h = await harness(); await h.start(); h.register()
    const call = h.agent.session.snapshotEvents().find(event => event.type === 'tool/call')!
    if (call.type !== 'tool/call') throw new Error('Missing call')
    h.agent.session.append('tool/call', call.data)
    await expect(h.reconcile()).rejects.toThrow('duplicated or mismatched')
    expect(h.resolver).not.toHaveBeenCalled()
  })

  it('retains completed native receipts without certifying engineering success', async () => {
    const h = await harness(); await h.start(); h.register()
    const original = h.resolver.getMockImplementation()!
    h.resolver.mockImplementation(async request => ({ ...await original(request), outcome: 'completed', receipt: { checks: [{ passed: false }] } }))
    const after = (await h.reconcile()).runs[0]!
    expect(after.phase).toBe('paused'); expect(after.tasks[0]?.certificates).toEqual([])
    expect(after.tasks[0]?.evidence.at(-1)?.data).toMatchObject({
      nativeReconciliation: { result: { receipt: { checks: [{ passed: false }] } } },
    })
  })

  it('automatically settles an authenticated rejection before the next prompt, preserving the same running node', async () => {
    const h = await harness(); h.register(); await h.start()
    expect((await h.run()).phase).toBe('active')
    expect((await h.run()).tasks[0]?.phase).toBe('running')
    expect(h.adapter.requests).toHaveLength(2)
    expect((await h.durable()).tables.native).toEqual({}); expect(h.calls()).toBe(1)
  })

  it('admits one named continuation and retains its exact source request without adding executions or attempts', async () => {
    const h = await harness(); await h.start(); h.register(); await h.reconcile()
    const request = { requestId: '4a14c18b-5f41-4b26-9c5c-4f3c5859c914', text: 'Read the original case before the next legal action.' }
    const ref = await h.ref()
    const resumed = await h.ctx.productionStudio.resume(h.agent.id, ref, request)
    await h.agent.whenIdle()
    const messages = h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user-approval' && event.data.source.rpcId === request.requestId)
    expect(messages).toHaveLength(1)
    const message = messages[0]
    expect(message?.type === 'user/message' && message.data.content.some(block => block.type === 'text' && block.text.includes(request.text))).toBe(true)
    expect(resumed.runs[0]?.tasks[0]?.evidence.at(-1)?.data).toMatchObject({ productionContinuation: request })
    expect((await h.run()).executions).toBe(1); expect((await h.run()).tasks[0]?.attempts).toBe(1)
    await expect(h.ctx.productionStudio.resume(h.agent.id, ref, request)).rejects.toThrow('changed')
    await h.ctx.productionStudio.pause(h.agent.id, await h.ref())
    await expect(h.ctx.productionStudio.resume(h.agent.id, await h.ref(), request)).rejects.toThrow('already admitted')
    expect(h.calls()).toBe(1)
  })

  it('does not resend an admitted continuation when steering throws with an unknown delivery outcome', async () => {
    const h = await harness(); await h.start(); h.register(); await h.reconcile()
    const request = { requestId: 'f06bcb98-11f6-46d7-b1c6-13c9c9303d14', text: 'Continue from the retained receipt.' }
    const steer = vi.spyOn(h.agent, 'steer').mockImplementation(() => { throw new Error('Unknown inbox delivery') })
    await expect(h.ctx.productionStudio.resume(h.agent.id, await h.ref(), request)).rejects.toThrow('Unknown inbox delivery')
    expect((await h.run()).tasks[0]?.evidence.at(-1)?.data).toMatchObject({ productionContinuation: request })
    await h.ctx.productionStudio.pause(h.agent.id, await h.ref())
    await expect(h.ctx.productionStudio.resume(h.agent.id, await h.ref(), request)).rejects.toThrow('already admitted')
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized complete settlement evidence before saving or releasing its lease', async () => {
    const h = await harness(1000); await h.start(); h.register()
    const original = h.resolver.getMockImplementation()!
    h.resolver.mockImplementation(async request => ({ ...await original(request), receipt: { detail: '诊断'.repeat(1000) } }))
    await expect(h.reconcile()).rejects.toThrow('retained byte limit')
    expect((await h.run()).phase).toBe('unknown')
    expect((await h.durable()).tables.native['Rhino']).not.toHaveProperty('settlement')
  })

  it('keeps quarantine until the recorded settlement checkpoint has durably flushed', async () => {
    const h = await harness(); await h.start(); h.register()
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
    const spy = vi.spyOn(h.ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(h.reconcile()).rejects.toThrow('checkpoint is pending')
    expect((await h.durable()).tables.native['Rhino']).toBeDefined()
    spy.mockImplementation(flush)
    await h.reconcile()
    expect((await h.durable()).tables.native).toEqual({})
    expect(h.resolver).toHaveBeenCalledTimes(1); expect(h.calls()).toBe(1)
  })

  it.each(['sessions', 'native-delete'] as const)('recovers a durable settlement after %s failure and service restart without consulting or replaying the Host', async (failure) => {
    const h = await harness(); await h.start(); await h.legacyEvidence(largeDiagnostic()); h.register()
    const unit = h.unit(), put = unit.putRecord.bind(unit), remove = unit.deleteRecord.bind(unit)
    let failed = false
    vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
      if (!failed && failure === 'sessions' && table === 'sessions') { failed = true; throw new Error('Injected settlement storage outage') }
      return put(table, key, value)
    })
    vi.spyOn(unit, 'deleteRecord').mockImplementation(async (table, key) => {
      if (!failed && failure === 'native-delete' && table === 'native') { failed = true; throw new Error('Injected settlement storage outage') }
      return remove(table, key)
    })
    await expect(h.reconcile()).rejects.toThrow('storage outage')
    expect((await h.durable()).tables.native['Rhino']).toBeDefined()
    await expect(h.ctx.productionStudio.resume(h.agent.id, await h.ref())).rejects.toThrow('settlement publication is pending')
    await h.reload()
    await h.reconcile()
    expect((await h.run()).phase).toBe('paused')
    expect((await h.durable()).tables.native).toEqual({})
    expect(h.resolver).toHaveBeenCalledTimes(1); expect(h.calls()).toBe(1)
  })
})
