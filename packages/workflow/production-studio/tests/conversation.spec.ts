import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ProductionStudio, { decodeProductionState } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { ConversationWorkflowProvider, ProductionCaseView, ProductionRun, ProductionState } from '../src/types.ts'
import { writeFixtureCase } from './fixture-case.ts'

const contexts: Context[] = [], roots: string[] = [], releases: (() => void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const release of releases.splice(0)) release()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(script?: ConstructorParameters<typeof MockAdapter>[0], config: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-conversation-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(FsLocal, { cwd: root })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(root, 'state') }); await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const kv = ctx.storage.backend.get('json').kv
  if (!kv) throw new Error('Expected the real JSON storage backend')
  const open = kv.open.bind(kv)
  let unit: KvUnit | undefined
  vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => { const opened = await open(descriptor); if (descriptor.name === 'production_studio') unit = opened; return opened })
  const driver = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script ?? [toolCallResponse('baseline-call', 'conversation_step', { finish: true }), toolCallResponse('manufacture-call', 'conversation_step', { finish: true }), textResponse('Done from the same conversation')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('conversation-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const fiber = await ctx.plugin(ProductionStudio, config)
  await ctx.productionStudio.get(agent.id)
  const { input, receipt: fixtureReceipt } = await writeFixtureCase(root)
  if (typeof fixtureReceipt !== 'object' || fixtureReceipt === null || Array.isArray(fixtureReceipt)) throw new Error('Expected an object fixture receipt')
  const receipt = fixtureReceipt
  const errors = vi.spyOn(ctx.logger, 'error')
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === agent.id) events.push(event) })
  let release = (): void => {}, started = (): void => {}
  let deferred = false, count = 0, unknown = false
  const pending = new Promise<void>((resolve) => { release = resolve }), dispatch = new Promise<void>((resolve) => { started = resolve })
  releases.push(release)
  ctx.tools.register(defineTool({ name: 'conversation_step', description: 'Actual trusted conversation fixture operation', parameters: { finish: { type: 'boolean' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { count++; started(); if (deferred) await pending; return JSON.stringify(unknown ? { ...receipt, workflow: { stage: 'verification_unknown' } } : receipt) } }))
  const provider: ConversationWorkflowProvider = { id: 'aea-fixture', toolNames: ['conversation_step'], appliesTo: current => current === agent, start: () => ({ key: input.caseId, objective: 'Verify the supplied drawing', input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Verify the supplied drawing' } } }), observe: call => typeof call.arguments === 'object' && call.arguments !== null && !Array.isArray(call.arguments) && call.arguments['finish'] === true ? { outlet: 'success' } : undefined }
  const registerProvider = () => ctx.productionStudio.registerConversationWorkflow(provider)
  registerProvider()
  const call = (finish = false) => ctx.tools.execute({ callId: ToolCallId(`direct-${count}`), name: 'conversation_step', arguments: { finish }, agent, signal: new AbortController().signal })
  const snapshot = () => ctx.productionStudio.get(agent.id)
  const run = async () => { const value = (await snapshot()).runs.at(-1); if (!value) throw new Error('No conversation run'); return value }
  const saved = async (): Promise<ProductionState> => {
    const document: unknown = JSON.parse(await readFile(join(root, 'state', 'production_studio.json'), 'utf8'))
    if (typeof document !== 'object' || document === null || !('tables' in document)) throw new Error('Expected a durable production domain')
    const tables = document.tables
    if (typeof tables !== 'object' || tables === null || !('sessions' in tables)) throw new Error('Expected durable sessions')
    const sessions = tables.sessions
    if (typeof sessions !== 'object' || sessions === null || !(agent.id in sessions)) throw new Error('Expected the durable parent workflow')
    return decodeProductionState(sessions[agent.id as keyof typeof sessions])
  }
  const persistedEvents = async (): Promise<readonly SessionEvent[]> => {
    const reader = await ctx.sessionPersistence.open(agent.id, 'read')
    try { return (await reader.read()).events } finally { await reader.close() }
  }
  const seedSaved = async (state: ProductionState): Promise<void> => {
    await writeFile(join(root, 'state', 'production_studio.json'), JSON.stringify({
      unit: { name: 'production_studio', version: 1 }, global: null,
      tables: { sessions: { [agent.id]: decodeProductionState(state) }, native: {} },
    }))
  }
  const storageUnit = (): KvUnit => { if (!unit) throw new Error('Production unit has not opened'); return unit }
  return {
    ctx, root, agent, adapter, fiber, events, call, run, snapshot, saved, persistedEvents, storageUnit, provider,
    registerProvider, receipt, errors, release, dispatch, seedSaved,
    defer: () => { deferred = true }, unknown: () => { unknown = true }, count: () => count,
  }
}

describe('one conversation, one production executor', () => {
  it('retains a known terminal failure without scheduling repair', async () => {
    const h = await harness()
    h.receipt['workflow'] = { control: { status: 'capability_blocked', terminal: true,
      reasonCode: 'no_executable_next_action', nextActions: [] } }
    h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Development capability blocked: no_executable_next_action' })
    expect((await h.call()).isError).toBe(false)
    const run = await h.run(), task = run.tasks.find(item => item.nodeId === 'baseline')!
    expect(run.phase).toBe('blocked')
    expect(task.phase).toBe('blocked'); expect(task.output).toEqual(h.receipt)
    expect(task.evidence.at(-1)?.data).toEqual(h.receipt)
    expect(task.settledOperationId).toBe('direct-0'); expect(task.pendingOutlet).toBeUndefined()
    expect(run.tasks.some(item => ['ready', 'running', 'human'].includes(item.phase))).toBe(false)
    expect(run.tasks.find(item => item.nodeId === 'repair')?.attempts).toBe(0)
    expect((await h.saved()).runs[0]?.phase).toBe('blocked')
    expect((await h.call()).isError).toBe(true); expect(h.count()).toBe(1)
  })

  describe('tool-call text after every tool is withdrawn', () => {
    const leak = () => { throw new LlmError('DeepSeek Messages returned tool-call markup as text while the request declared no tools', 'TOOL_MARKUP_WITHOUT_TOOLS') }
    const blocked = async (script: ConstructorParameters<typeof MockAdapter>[0]) => {
      const h = await harness([toolCallResponse('blocked-call', 'conversation_step', { finish: false }), ...script])
      h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Native execution is quarantined by an unresolved operation' })
      h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Verify the supplied drawing' }], source: { kind: 'user' } }))
      await h.agent.whenIdle()
      const notices = h.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'production-studio')
      return { ...h, notices, end: h.events.at(-1) }
    }

    it('records one notice and retries so the same turn ends with a plain-text reply', async () => {
      const h = await blocked([leak, textResponse('The run is blocked by an unresolved native operation.')])
      expect(h.adapter.requests).toHaveLength(3)
      const [, withdrawn, retried] = h.adapter.requests
      expect(withdrawn?.tools ?? []).toEqual([])
      expect(withdrawn?.messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text'
        && block.text.includes('phase=blocked') && block.text.includes('This step offers no tools. Do not write tool calls; reply in plain text.')))).toBe(true)
      expect(retried?.tools ?? []).toEqual([])
      expect(retried?.messages.slice(0, -1)).toEqual(withdrawn?.messages)
      expect(retried?.messages.at(-1)).toMatchObject({ role: 'user', source: { kind: 'production-studio', form: 'notice' },
        content: [{ type: 'text', text: expect.stringContaining('No tools are available in this request') as string }] })
      expect(h.notices).toHaveLength(1)
      expect(h.end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      expect(h.events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
      expect((await h.run()).phase).toBe('blocked'); expect(h.count()).toBe(1)
    })

    it('ends the turn on a second leak in the same step without another notice', async () => {
      const h = await blocked([leak, leak])
      expect(h.adapter.requests).toHaveLength(3)
      expect(h.notices).toHaveLength(1)
      expect(h.end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TOOL_MARKUP_WITHOUT_TOOLS' } } } })
      expect(h.count()).toBe(1)
    })

    it('leaves other failures and conversations it does not govern to later recovery', async () => {
      const retried = await blocked([() => { throw new LlmError('busy', 'EMPTY_RESPONSE') }])
      expect(retried.notices).toHaveLength(0)
      expect(retried.end).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE' } } } })
      const h = await harness([leak])
      h.provider.appliesTo = () => false
      h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await h.agent.whenIdle()
      expect(h.events.some(event => event.type === 'user/message' && event.data.source.kind === 'production-studio')).toBe(false)
      expect(h.events.at(-1)).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'TOOL_MARKUP_WITHOUT_TOOLS' } } } })
    })
  })

  it('explicit pause and resume reopen only the last settled failed node without resetting its receipt or budget', async () => {
    const h = await harness()
    h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Known capability failure' })
    await h.call()
    const failed = await h.run()
    expect(failed.phase).toBe('blocked')
    const original = structuredClone(failed.tasks[0]!)
    await h.ctx.productionStudio.pause(h.agent.id, { runId: failed.id, revision: failed.revision })
    const paused = await h.run()
    expect(paused.tasks[0]?.phase).toBe('paused')
    expect(paused.executions).toBe(failed.executions)
    expect(paused.tasks[0]?.settledOperationId).toBe(original.settledOperationId)
    expect(paused.tasks[0]?.evidence).toEqual(original.evidence)
    expect((await h.call()).isError).toBe(true)
    await h.ctx.productionStudio.resume(h.agent.id, { runId: paused.id, revision: paused.revision })
    const resumed = await h.run()
    expect(resumed.id).toBe(failed.id); expect(resumed.phase).toBe('active')
    expect(resumed.executions).toBe(failed.executions)
    expect(resumed.tasks[0]?.attempts).toBe(original.attempts)
    expect(h.count()).toBe(1)
  })

  it('retains the immutable failed boundary when a repair terminates and is explicitly resumed', async () => {
    const h = await harness()
    h.provider.observe = () => ({ outlet: 'failure', message: 'Needs repair' })
    await h.call()
    const repairing = await h.run()
    const incoming = structuredClone(repairing.tasks.find(task => task.nodeId === 'repair')?.incoming)
    expect(incoming).toBeDefined()
    h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Known capability failure' })
    await h.call()
    const failed = await h.run()
    expect(failed.phase).toBe('blocked')
    expect(failed.tasks.find(task => task.nodeId === 'repair')?.incoming).toEqual(incoming)
    await h.ctx.productionStudio.pause(h.agent.id, { runId: failed.id, revision: failed.revision })
    const paused = await h.run()
    await h.ctx.productionStudio.resume(h.agent.id, { runId: paused.id, revision: paused.revision })
    const resumed = await h.run()
    expect(resumed.tasks.find(task => task.nodeId === 'repair')?.incoming).toEqual(incoming)
    expect(resumed.executions).toBe(failed.executions)
    expect((await h.saved()).runs[0]?.tasks.find(task => task.nodeId === 'repair')?.incoming).toEqual(incoming)
    expect(h.count()).toBe(2)
  })

  it('keeps a blocked run unchanged while native execution is leased and accepts pause after settlement', async () => {
    const h = await harness()
    h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Known capability failure' })
    await h.call()
    const failed = await h.run(), saved = await h.saved(), checkpoints = h.events.length
    let markStarted = (): void => {}, release = (): void => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    releases.push(release)
    h.ctx.tools.register(defineTool({ name: 'rhino_lease_fixture', description: 'Hold the native lease for the recovery check', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { markStarted(); await released; return 'Known native result' } }))
    const pending = h.ctx.tools.execute({ callId: ToolCallId('leased-call'), name: 'rhino_lease_fixture', arguments: {}, agent: h.agent, signal: new AbortController().signal })
    await started
    try {
      await expect(h.ctx.productionStudio.pause(h.agent.id, { runId: failed.id, revision: failed.revision })).rejects.toThrow('Native execution is still leased')
      expect(await h.run()).toEqual(failed)
      expect(await h.saved()).toEqual(saved)
      expect(h.events).toHaveLength(checkpoints)
    } finally { release(); await pending }
    await h.ctx.productionStudio.pause(h.agent.id, { runId: failed.id, revision: failed.revision })
    const paused = await h.run()
    expect(paused.phase).toBe('paused'); expect(paused.tasks[0]?.phase).toBe('paused')
    expect(paused.executions).toBe(failed.executions); expect(paused.tasks[0]?.attempts).toBe(failed.tasks[0]?.attempts)
  })

  it.each(['budget', 'different node'] as const)('rejects blocked pause without changing state when recovery fails its %s check', async (reason) => {
    const h = await harness(undefined, reason === 'budget' ? { defaultMaxExecutions: 1 } : {})
    h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Known capability failure' })
    await h.call()
    const failed = await h.run(), saved = await h.saved(), checkpoints = h.events.length
    await expect(h.ctx.productionStudio.pause(h.agent.id, { runId: failed.id, revision: failed.revision,
      ...(reason === 'different node' ? { nodeId: 'repair' } : {}) })).rejects.toThrow(reason === 'budget' ? 'budget exhausted' : 'Only the last settled failed')
    expect(await h.run()).toEqual(failed)
    expect(await h.saved()).toEqual(saved)
    expect(h.events).toHaveLength(checkpoints)
    expect(h.count()).toBe(1)
  })

  it('routes ordinary repair failures autonomously even when untrusted receipt data claims terminal', async () => {
    const h = await harness()
    h.receipt['terminal'] = true
    h.provider.observe = () => ({ outlet: 'failure', message: 'Continue the legal repair' })
    expect((await h.call()).isError).toBe(false)
    const routed = await h.run()
    expect(routed.phase).toBe('active')
    expect(routed.tasks.find(item => item.nodeId === 'repair')?.phase).toBe('ready')
    expect(h.errors.mock.calls).toEqual([])
    h.provider.observe = () => undefined
    expect((await h.call()).isError).toBe(false)
    expect((await h.run()).tasks.find(item => item.nodeId === 'repair')?.phase).toBe('running')
    expect(h.count()).toBe(2)
  })

  it('persists the latest adapter case view on the run and replaces it on the next receipt', async () => {
    const h = await harness()
    const view = (revision: number, used: number): Omit<ProductionCaseView, 'observedAt'> => ({ caseId: 'case-1', inputVersion: 'v1', revision,
      phase: 'improve', stage: 'improvement_proposal', candidates: { used, limit: 8 }, hostCalls: { used: revision, limit: 48 },
      rows: [{ candidateId: 'c1', kind: 'baseline', searchStatus: 'verified', searchCounts: { pieces: 1, bends: 10, welds: 7 } }],
      finishBlockers: ['Try a second source'], nextActions: ['suggest_candidates'] })
    h.provider.observe = () => ({ caseView: view(3, 1) })
    const before = Date.now()
    expect((await h.call()).isError).toBe(false)
    const { observedAt, ...first } = (await h.run()).case ?? { observedAt: 0 }
    expect(first).toEqual(view(3, 1))
    expect(observedAt).toBeGreaterThanOrEqual(before)
    h.provider.observe = () => ({ caseView: view(4, 2) })
    expect((await h.call()).isError).toBe(false)
    expect((await h.run()).case?.revision).toBe(4)
    expect((await h.saved()).runs[0]?.case?.candidates).toEqual({ used: 2, limit: 8 })
    h.provider.observe = () => undefined
    expect((await h.call()).isError).toBe(false)
    expect((await h.run()).case?.revision).toBe(4)
  })

  it('keeps an unresolved receipt unknown even if its provider claims a terminal failure', async () => {
    const h = await harness(); h.unknown()
    h.provider.observe = () => ({ outlet: 'failure', terminal: true, message: 'Claimed capability terminal' })
    expect((await h.call()).isError).toBe(false)
    const run = await h.run()
    expect(run.phase).toBe('unknown')
    expect(run.tasks.find(item => item.nodeId === 'baseline')?.phase).toBe('unknown')
    expect(run.tasks.find(item => item.nodeId === 'repair')?.phase).toBe('waiting')
    expect((await h.call()).isError).toBe(true); expect(h.count()).toBe(1)
  })

  it('archives large ordinary receipts at ingestion but applies the unchanged gate byte limit to their restored contents', async () => {
    const h = await harness()
    h.receipt['diagnostic'] = '原始诊断'.repeat(25000)
    expect((await h.call(false)).isError).toBe(false)
    const first = await h.run(), retained = first.tasks[0]!.evidence[0]!
    expect(retained.data).toHaveProperty('productionEvidenceReference')
    expect(Buffer.byteLength(JSON.stringify(first.tasks[0]!.evidence))).toBeLessThanOrEqual(262144)
    expect((await h.ctx.productionStudio.readEvidence(h.agent.id, retained)).data).toEqual(h.receipt)
    expect((await h.call(true)).isError).toBe(false)
    const gate = (await h.run()).tasks.find(item => item.nodeId === 'geometry')!
    expect(gate.phase).toBe('blocked'); expect(gate.certificates).toEqual([])
    expect(gate.output).toEqual({ error: 'Objective evidence exceeds the configured retained byte limit' })
    expect(h.count()).toBe(2)
  })

  it('durably pauses with the complete known receipt if diagnostic archival fails before workflow observation', async () => {
    const h = await harness(); h.receipt['diagnostic'] = '原始诊断'.repeat(25000)
    const unit = h.storageUnit(), put = unit.putRecord.bind(unit)
    vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
      if (table === 'evidence') throw new Error('Diagnostic archive unavailable')
      return put(table, key, value)
    })
    expect((await h.call(true)).isError).toBe(false)
    const task = (await h.run()).tasks[0]!
    expect(task.phase).toBe('paused'); expect(task.message).toContain('diagnostic archival failed')
    expect(task.evidence[0]!.data).toEqual(h.receipt); expect(task.output).toEqual(h.receipt)
    expect((await h.saved()).runs[0]!.tasks[0]!.evidence[0]!.data).toEqual(h.receipt)
    expect((await h.call(true)).isError).toBe(true); expect(h.count()).toBe(1)
  })

  it('auto-starts from a real parent chat call, crosses actual file gates and emits replayable same-run checkpoints', async () => {
    const { agent, adapter, run, events, count, errors } = await harness()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Verify the supplied drawing' }], source: { kind: 'user' } }))
    await vi.waitFor(async () => {
      expect((await run()).phase, errors.mock.calls.map(args => args.map(String).join(' ')).join('\n')).toBe('complete')
    }, { timeout: 10_000 })
    await agent.whenIdle()
    expect(count()).toBe(2)
    expect(adapter.requests).toHaveLength(3)
    const value = await run()
    expect(value.mode).toBe('conversation')
    expect(value.tasks.every(task => task.childSessionId === undefined)).toBe(true)
    expect(value.tasks.find(task => task.nodeId === 'delivery')?.certificates.toSorted()).toEqual(['files', 'geometry', 'goal', 'manufacturing'])
    const checkpoints = events.filter(event => event.type === 'production/checkpoint')
    expect(checkpoints.length).toBeGreaterThan(5)
    expect(checkpoints.every(event => event.ignorable === true && event.type === 'production/checkpoint' && event.data.run.id === value.id)).toBe(true)
  })

  it('pauses admission without discarding the known in-flight result or replaying it on resume', async () => {
    const h = await harness(); h.defer(); const inFlight = h.call(true); await h.dispatch
    const active = await h.run()
    await h.ctx.productionStudio.pause(h.agent.id, { runId: active.id, revision: active.revision })
    h.release(); await inFlight
    expect((await h.run()).phase).toBe('paused')
    expect((await h.call()).isError).toBe(true); expect(h.count()).toBe(1)
    const paused = await h.run(); await h.ctx.productionStudio.resume(h.agent.id, { runId: paused.id, revision: paused.revision })
    expect(h.count()).toBe(1)
    expect((await h.call(true)).isError).toBe(false); expect(h.count()).toBe(2)
  })

  it('retains a known receipt and retries only a failed historical checkpoint append', async () => {
    const h = await harness(); h.defer()
    const pending = h.call(false); await h.dispatch
    const spy = vi.spyOn(h.agent.session, 'append').mockImplementationOnce(() => { throw new Error('checkpoint fixture failure') })
    h.release(); expect((await pending).isError).toBe(false)
    const value = await h.run(), task = value.tasks.find(item => item.nodeId === 'baseline')!
    expect(task.phase).toBe('running'); expect(task.output).toBeDefined(); expect(task.settledOperationId).toBe('direct-0')
    expect(h.count()).toBe(1); expect((await h.snapshot()).error).toContain('checkpoint')
    const saved = await h.saved()
    expect(saved.pendingCheckpoints?.some(checkpoint => checkpoint.id === value.id && checkpoint.revision === value.revision)).toBe(true)
    expect(saved.runs[0]?.tasks.find(item => item.nodeId === 'baseline')?.output).toEqual(h.receipt)
    spy.mockRestore()
    expect((await h.call(true)).isError).toBe(false)
    expect(h.count()).toBe(2)
    expect(h.events.some(event => event.type === 'production/checkpoint' && event.data.run.revision === value.revision)).toBe(true)
  })

  it('pauses between known receipts on conversation disposal without creating a false unknown', async () => {
    const h = await harness(); await h.call(false)
    h.ctx.emit('agent/disposed', { agent: h.agent })
    await vi.waitFor(async () => { expect((await h.run()).phase).toBe('paused') })
    const value = await h.run(), task = value.tasks.find(item => item.nodeId === 'baseline')!
    expect(task.phase).toBe('paused'); expect(task.output).toBeDefined(); expect(task.operationId).toBeUndefined()
    await h.ctx.productionStudio.resume(h.agent.id, { runId: value.id, revision: value.revision })
    expect((await h.call(true)).isError).toBe(false); expect(h.count()).toBe(2)
  })

  it('waits for the whole parent call settlement before closing its storage domain', async () => {
    const h = await harness(); h.defer(); const inFlight = h.call(false); await h.dispatch
    let closed = false
    const stopping = h.fiber.dispose().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(closed).toBe(false)
    h.release(); expect((await inFlight).isError).toBe(false); await stopping
    const replacement = await h.ctx.plugin(ProductionStudio)
    const value = await h.run(), task = value.tasks.find(item => item.nodeId === 'baseline')!
    expect(value.phase).toBe('paused'); expect(task.output).toBeDefined(); expect(task.settledOperationId).toBe('direct-0'); expect(h.count()).toBe(1)
    await replacement.dispose()
  })

  it('explicit resume wakes the same idle chat and preserves its run and consumed budget', async () => {
    const h = await harness([toolCallResponse('resume-manufacture', 'conversation_step', { finish: true }), textResponse('Resumed same workflow')])
    await h.call(true)
    const before = await h.run()
    await h.ctx.productionStudio.pause(h.agent.id, { runId: before.id, revision: before.revision })
    const paused = await h.run()
    await h.ctx.productionStudio.resume(h.agent.id, { runId: paused.id, revision: paused.revision })
    await h.agent.whenIdle()
    const value = await h.run()
    expect(value.id).toBe(before.id); expect(value.phase).toBe('complete'); expect(value.executions).toBeGreaterThan(before.executions)
    expect(h.count()).toBe(2); expect(h.adapter.requests).toHaveLength(2)
    expect(h.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user-approval')).toBe(true)
    expect((await h.snapshot()).runs).toHaveLength(1)
  })

  it('retains an exact unresolved invocation and refuses resume or a second dispatch', async () => {
    const h = await harness(); h.unknown()
    expect((await h.call(true)).isError).toBe(false)
    const value = await h.run()
    expect(value.phase).toBe('unknown')
    expect(value.tasks.find(task => task.nodeId === 'baseline')?.settledOperationId).toBe('direct-0')
    await expect(h.ctx.productionStudio.resume(h.agent.id, { runId: value.id, revision: value.revision })).rejects.toThrow('Unknown')
    expect((await h.call()).isError).toBe(true); expect(h.count()).toBe(1)
  })

  it.each(['false', 'throw'] as const)('saves the exact known settlement while an admission checkpoint flush returns %s', async (failure) => {
    const h = await harness(); h.defer()
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
    let checkpoints = 0
    const spy = vi.spyOn(h.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (++checkpoints >= 2) {
        if (failure === 'throw') throw new Error('Fixture Session durability failure')
        return false
      }
      return flush(session)
    })
    const pending = h.call(false); await h.dispatch
    const admitted = await h.saved(), original = admitted.runs[0]
    expect(original?.tasks.find(item => item.nodeId === 'baseline')?.operationId).toBe('direct-0')
    expect(admitted.pendingCheckpoints?.length).toBeGreaterThan(0)
    h.release(); expect((await pending).isError).toBe(false)
    const saved = await h.saved(), settled = saved.runs[0]?.tasks.find(item => item.nodeId === 'baseline')
    expect(settled?.output).toEqual(h.receipt)
    expect(settled?.settledOperationId).toBe('direct-0')
    expect(settled?.operationId).toBeUndefined()
    expect(settled?.phase).not.toBe('unknown')
    expect(saved.pendingCheckpoints?.some(checkpoint => checkpoint.tasks.some(item => item.settledOperationId === 'direct-0' && item.output !== undefined))).toBe(true)
    expect((await h.call(true)).isError).toBe(true)
    expect(h.count()).toBe(1)
    spy.mockRestore()
    await h.ctx.systemPrompt.assemble({ agent: h.agent })
    expect((await h.saved()).pendingCheckpoints).toBeUndefined()
    expect(h.count()).toBe(1)
    const persisted = (await h.persistedEvents()).filter(event => event.type === 'production/checkpoint')
    const keys = persisted.map(event => `${event.data.run.id}:${event.data.run.revision}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(persisted.some(event => event.data.run.tasks.some(item => item.settledOperationId === 'direct-0' && item.output !== undefined))).toBe(true)
  })

  it('restores a durable unacknowledged outbox without duplicating an already persisted checkpoint or dispatching again', async () => {
    const h = await harness(); h.defer()
    const pending = h.call(false); await h.dispatch
    const unit = h.storageUnit(), put = unit.putRecord.bind(unit)
    vi.spyOn(unit, 'putRecord').mockImplementation((table, key, value) => {
      if (table === 'sessions' && decodeProductionState(value).pendingCheckpoints === undefined) return Promise.reject(new Error('Fixture outbox acknowledgement failure'))
      return put(table, key, value)
    })
    h.release(); expect((await pending).isError).toBe(false)
    const saved = await h.saved(), checkpoint = saved.pendingCheckpoints?.[0]
    expect(checkpoint).toBeDefined()
    expect(saved.runs[0]?.tasks.find(item => item.nodeId === 'baseline')?.output).toEqual(h.receipt)
    const before = (await h.persistedEvents()).filter(event => event.type === 'production/checkpoint')
    expect(before.filter(event => event.data.run.id === checkpoint?.id && event.data.run.revision === checkpoint.revision)).toHaveLength(1)
    await h.fiber.dispose()
    expect((await h.saved()).pendingCheckpoints?.length).toBeGreaterThan(0)
    const replacement = await h.ctx.plugin(ProductionStudio); h.registerProvider()
    const restored = await h.run()
    expect(restored.id).toBe(saved.runs[0]?.id)
    expect(restored.phase).toBe('paused')
    expect(restored.tasks.find(item => item.nodeId === 'baseline')?.settledOperationId).toBe('direct-0')
    expect((await h.saved()).pendingCheckpoints).toBeUndefined()
    expect(h.count()).toBe(1)
    const after = (await h.persistedEvents()).filter(event => event.type === 'production/checkpoint')
    const keys = after.map(event => `${event.data.run.id}:${event.data.run.revision}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(after.filter(event => event.data.run.id === checkpoint?.id && event.data.run.revision === checkpoint.revision)).toHaveLength(1)
    await replacement.dispose()
  })

  it('steers a resume during the cancellation tail into the same parent and run', async () => {
    const h = await harness(['hang-slow', toolCallResponse('cancel-tail-manufacture', 'conversation_step', { finish: true }), textResponse('Same run resumed after cancellation')])
    await h.call(true)
    const original = await h.run()
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the current manufacture step' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(h.adapter.requests).toHaveLength(1) })
    await h.ctx.productionStudio.pause(h.agent.id, { runId: original.id, revision: original.revision })
    h.agent.cancel({ kind: 'user' }, { keepInbox: true })
    expect(h.agent.status).toBe('running')
    const steer = vi.spyOn(h.agent, 'steer'), inject = vi.spyOn(h.agent, 'inject'), paused = await h.run()
    await h.ctx.productionStudio.resume(h.agent.id, { runId: paused.id, revision: paused.revision })
    expect(steer).toHaveBeenCalledTimes(1); expect(inject).not.toHaveBeenCalled()
    await h.agent.whenIdle()
    const resumed = await h.run()
    expect(resumed.id).toBe(original.id); expect(resumed.phase).toBe('complete')
    expect(h.count()).toBe(2); expect(h.adapter.requests).toHaveLength(3)
    expect((await h.snapshot()).runs).toHaveLength(1)
    expect(h.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user-approval')).toBe(true)
  })

  it('retains and durably pauses the exact known receipt when its provider observation throws', async () => {
    const h = await harness()
    vi.spyOn(h.provider, 'observe').mockImplementation(() => { throw new Error('Fixture workflow observation failure') })
    expect((await h.call(true)).isError).toBe(false)
    const value = await h.run(), task = value.tasks.find(item => item.nodeId === 'baseline')
    expect(value.phase).toBe('paused'); expect(task?.phase).toBe('paused')
    expect(task?.output).toEqual(h.receipt); expect(task?.settledOperationId).toBe('direct-0'); expect(task?.operationId).toBeUndefined()
    expect(task?.message).toContain('observation failed')
    const saved = await h.saved()
    expect(saved.runs[0]?.phase).toBe('paused')
    expect(saved.runs[0]?.tasks.find(item => item.nodeId === 'baseline')?.output).toEqual(h.receipt)
    expect((await h.call(true)).isError).toBe(true); expect(h.count()).toBe(1)
    expect((await h.persistedEvents()).some(event => event.type === 'production/checkpoint' && event.data.run.phase === 'paused')).toBe(true)
  })

  it('persists a failed read-only automatic gate without changing the known tool receipt to unknown', async () => {
    const h = await harness(undefined, { maxEvidenceBytes: 1 }); h.defer()
    const pending = h.call(true); await h.dispatch
    h.release(); expect((await pending).isError).toBe(false)
    const value = await h.run(), gate = value.tasks.find(item => item.nodeId === 'geometry')
    expect(gate?.phase).toBe('blocked')
    expect(gate?.output).toEqual({ error: 'Objective evidence exceeds the configured retained byte limit' })
    expect(gate?.message).toContain('Read-only evidence check failed')
    expect(value.tasks.find(item => item.nodeId === 'baseline')?.output).toEqual(h.receipt)
    expect(value.tasks.find(item => item.nodeId === 'repair')?.phase).toBe('ready')
    expect(value.tasks.some(item => item.phase === 'unknown')).toBe(false)
    expect((await h.saved()).runs[0]?.tasks.find(item => item.nodeId === 'geometry')?.phase).toBe('blocked')
    expect(h.count()).toBe(1)
  })

  it('retains the exact known settlement through domain write failure and blocks the next dispatch until metadata commits', async () => {
    const h = await harness(); h.defer()
    const pending = h.call(false); await h.dispatch
    const spy = vi.spyOn(h.storageUnit(), 'putRecord').mockRejectedValue(new Error('Fixture domain write failure'))
    h.release(); expect((await pending).isError).toBe(false)
    expect((await h.snapshot()).error).toContain('storage failed')
    const settlements = spy.mock.calls.filter(([table]) => table === 'sessions').map(([, , value]) => decodeProductionState(value))
    expect(settlements.some(state => state.runs.some(run => run.tasks.some(task => task.nodeId === 'baseline' && task.settledOperationId === 'direct-0' && task.operationId === undefined && JSON.stringify(task.output) === JSON.stringify(h.receipt))))).toBe(true)
    expect((await h.call(true)).isError).toBe(true); expect(h.count()).toBe(1)
    spy.mockRestore()
    await h.ctx.systemPrompt.assemble({ agent: h.agent })
    const saved = await h.saved(), task = saved.runs[0]?.tasks.find(item => item.nodeId === 'baseline')
    expect(task?.output).toEqual(h.receipt); expect(task?.settledOperationId).toBe('direct-0'); expect(task?.operationId).toBeUndefined()
    expect(saved.pendingCheckpoints).toBeUndefined(); expect(h.count()).toBe(1)
    expect((await h.snapshot()).error).toBeUndefined()
  })

  it('serializes recovery publication with a concurrent pause and retains the checkpoint whose flush returns false', async () => {
    const h = await harness()
    await h.call(false); await h.fiber.dispose()
    const state = await h.saved(), run = state.runs[0]
    if (!run) throw new Error('Expected the saved conversation run')
    run.revision = 5
    state.pendingCheckpoints = [{ ...structuredClone(run), revision: 4 }, structuredClone(run)]
    await h.seedSaved(state)
    const replacement = await h.ctx.plugin(ProductionStudio); h.registerProvider()
    let releaseFourth = (): void => {}, fourthStarted = (): void => {}
    const fourth = new Promise<void>((resolve) => { releaseFourth = resolve })
    const started = new Promise<void>((resolve) => { fourthStarted = resolve })
    releases.push(releaseFourth)
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
    let calls = 0, concurrent = 0, maximum = 0
    const spy = vi.spyOn(h.ctx.sessions, 'flush').mockImplementation(async (session) => {
      concurrent++; maximum = Math.max(maximum, concurrent)
      const call = ++calls
      try {
        if (call === 1) { fourthStarted(); await fourth; return await flush(session) }
        return false
      } finally { concurrent-- }
    })
    const recovering = h.snapshot(); await started
    const pausing = h.ctx.productionStudio.pause(h.agent.id, { runId: run.id, revision: run.revision })
    const pauseOutcome = pausing.then(() => null, (error: unknown) => error)
    const during = await h.snapshot()
    expect(during.runs[0]?.id).toBe(run.id)
    await new Promise(resolve => setTimeout(resolve, 30))
    const callsBeforeRelease = calls
    releaseFourth(); await recovering
    const failure = await pauseOutcome
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('checkpoint publication is pending')
    expect(callsBeforeRelease).toBe(1); expect(maximum).toBe(1)
    const saved = await h.saved()
    expect(saved.pendingCheckpoints?.map(checkpoint => checkpoint.revision)).toEqual([5])
    expect(saved.runs[0]?.tasks.find(task => task.nodeId === 'baseline')?.output).toEqual(h.receipt)
    expect(h.count()).toBe(1)
    spy.mockRestore()
    await h.ctx.systemPrompt.assemble({ agent: h.agent })
    expect((await h.saved()).pendingCheckpoints).toBeUndefined()
    const persisted = (await h.persistedEvents()).filter(event => event.type === 'production/checkpoint')
    expect(persisted.filter(event => event.data.run.id === run.id && event.data.run.revision === 5)).toHaveLength(1)
    expect(h.count()).toBe(1)
    await replacement.dispose()
  })

  it('blocks a gate whose AEA evidence fails and routes the run to repair', async () => {
    const h = await harness()
    await writeFixtureCase(h.root, true)
    expect((await h.call(true)).isError).toBe(false)
    const run = await h.run(), gate = run.tasks.find(task => task.nodeId === 'geometry')!
    expect(gate.phase).toBe('blocked')
    expect(gate.certificates).toEqual([])
    expect(gate.output).toMatchObject({ issue: 'Objective check failed: geometryVerified' })
    expect(run.tasks.find(task => task.nodeId === 'repair')?.phase).toBe('ready')
    expect(run.tasks.find(task => task.nodeId === 'manufacture')?.phase).toBe('waiting')
  })

  it.each([
    { label: 'an edited graph', edit: (run: ProductionRun) => { run.graph.nodes.find(node => node.id === 'manufacture')!.config.breakBefore = true }, error: 'edited workflow graph' },
    { label: 'an independently scheduled run', edit: (run: ProductionRun) => { run.mode = 'scheduled' }, error: 'scheduled runs are retired' },
  ])('keeps $label readable but refuses control changes and new admissions', async ({ edit, error }) => {
    const h = await harness()
    expect((await h.call(false)).isError).toBe(false)
    await h.fiber.dispose()
    const state = await h.saved(), run = state.runs[0]!
    edit(run)
    await h.seedSaved(state)
    const replacement = await h.ctx.plugin(ProductionStudio); h.registerProvider()
    const restored = await h.run()
    expect(restored.tasks.find(task => task.nodeId === 'baseline')?.output).toEqual(h.receipt)
    const ref = { runId: restored.id, revision: restored.revision }
    await expect(h.ctx.productionStudio.pause(h.agent.id, ref)).rejects.toThrow(error)
    await expect(h.ctx.productionStudio.resume(h.agent.id, ref)).rejects.toThrow(error)
    expect(h.count()).toBe(1)
    await replacement.dispose()
  })
})
