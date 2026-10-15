import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Subagent from '@deepseek-ai/dsh-subagent'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ProductionStudio, { createProductionGraph, validateProductionGraph } from '../src/index.ts'
import { ProductionChildren } from '../src/child-activation.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '../../../ptc-runtime/ptc-runtime/src/index.ts'
import { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import { applyReadTool } from '@deepseek-ai/dsh-tool-fs/src/read.ts'
import { writeFixtureCase } from './fixture-case.ts'
import type { ProductionGraph, ProductionRun } from '../src/types.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Scripted runtime keeps the real PTC tool dispatch and its policy checks. */
class PolicyPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = async () => ({ logs: [] })
  resolve(request: PtcRunRequest) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 } }
  run(request: PtcRunRequest) { return this.behavior(request) }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(script?: ConstructorParameters<typeof MockAdapter>[0], studio = true, mode: 'native' | 'ptc' = 'native') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FsLocal, { cwd: root })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode } })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'state') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(Subagent)
  await ctx.plugin(Fork)
  const driver = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script ?? [textResponse('I am done; all checks passed')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('production-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const serviceFiber = await ctx.plugin(studio ? ProductionStudio : () => {})
  const { input, receipt } = await writeFixtureCase(root)
  const execute = (name: string, callId: string) => ctx.tools.execute({
    callId: ToolCallId(callId), name, arguments: {}, agent, signal: new AbortController().signal,
  })
  return { ctx, root, agent, adapter, serviceFiber, input, receipt, execute }
}

function programGraph(): ProductionGraph {
  const graph = createProductionGraph(50, 3)
  for (const node of graph.nodes) {
    if (node.kind === 'agent') { node.kind = 'program'; node.config = { toolName: 'finalize_candidate', arguments: { node: node.id } }; delete node.resource }
  }
  return validateProductionGraph(graph)
}

async function current(ctx: Context, id: SessionId): Promise<ProductionRun> {
  const run = (await ctx.productionStudio.get(id)).runs.at(-1)
  if (!run) throw new Error('Expected a production run')
  return run
}


describe('production scheduling and delivery', () => {
  it('delivers after real binary file readback and objective gates, retaining the run graph version', async () => {
    const { ctx, agent, input, receipt } = await harness()
    const calls: string[] = []
    ctx.tools.register(defineTool({ name: 'finalize_candidate', description: 'Actual AEA string-value contract fixture', parameters: { node: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }, execute: async (args) => { const name = (args as { node: string }).node; calls.push(name); return JSON.stringify(receipt) } }))
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph: programGraph() })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Deliver the verified fixture drawing', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Deliver the verified fixture drawing' } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).phase).toBe('complete') })
    const delivered = await current(ctx, agent.id)
    expect(delivered.tasks.find(task => task.nodeId === 'delivery')?.certificates.sort()).toEqual(['files', 'geometry', 'goal', 'manufacturing'])
    expect(delivered.tasks.find(task => task.nodeId === 'file-check')?.evidence.some(item => item.toolName === 'production_aea_evidence' && typeof item.data === 'object' && item.data !== null && !Array.isArray(item.data) && item.data['fileReadbackVerified'] === true)).toBe(true)
    expect(calls).not.toContain('repair')
    await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: saved.graph.version, graph: { ...saved.graph, name: 'Next run draft' } })
    expect((await current(ctx, agent.id)).graph.version).toBe(saved.graph.version)
    await expect(ctx.productionStudio.resume(agent.id, { runId: delivered.id, revision: delivered.revision })).rejects.toThrow('Delivered')
  })

  it('keeps an independent branch running while a human gate blocks only its dependents', async () => {
    const { ctx, agent, input, receipt } = await harness()
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'External fixture proof producer', parameters: { node: { type: 'string' } }, execute: async () => [{ type: 'text', text: JSON.stringify(receipt) }] }))
    const graph = programGraph()
    const main = graph.edges.find(edge => edge.fromNode === 'baseline' && edge.fromPort === 'success')
    if (!main) throw new Error('Expected baseline edge')
    main.toNode = 'decision'
    graph.nodes.push({ id: 'decision', label: 'Allow this plan', kind: 'human', x: 10, y: 100, inputs: [{ id: 'input', type: 'candidate' }], outputs: [{ id: 'success', type: 'candidate', outlet: 'success' }], maxAttempts: 1, config: { question: 'Allow this plan?' } })
    graph.edges.push({ id: 'decision-to-geometry', fromNode: 'decision', fromPort: 'success', toNode: 'geometry', toPort: 'input' })
    graph.nodes.push({ id: 'analysis', label: 'Independent analysis', kind: 'program', x: 10, y: 200, inputs: [], outputs: [], maxAttempts: 1, config: { toolName: 'finalize_candidate', arguments: {} } })
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Deliver after explicit decision', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Deliver after explicit decision' } } })
    await vi.waitFor(async () => { const run = await current(ctx, agent.id); expect(run.tasks.find(task => task.nodeId === 'decision')?.phase).toBe('human'); expect(run.tasks.find(task => task.nodeId === 'analysis')?.phase).toBe('complete') })
    let run = await current(ctx, agent.id)
    expect(run.tasks.find(task => task.nodeId === 'geometry')?.phase).toBe('waiting')
    await ctx.productionStudio.pause(agent.id, { runId: run.id, revision: run.revision, nodeId: 'geometry' })
    run = await current(ctx, agent.id)
    await ctx.productionStudio.answer(agent.id, { runId: run.id, revision: run.revision, nodeId: 'decision', answer: 'Proceed with this plan', accepted: true })
    run = await current(ctx, agent.id)
    expect(run.tasks.find(task => task.nodeId === 'geometry')?.phase).toBe('paused')
    await ctx.productionStudio.resume(agent.id, { runId: run.id, revision: run.revision, nodeId: 'geometry' })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).phase).toBe('complete') })
  })

  it('marks interrupted work unknown across service reload and refuses replay', async () => {
    const { ctx, agent, input, serviceFiber, receipt } = await harness()
    let invocations = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'A cancellable external operation', parameters: { node: { type: 'string' } }, execute: async (_args, exec) => { invocations++; await new Promise<void>((resolve) => { if (exec.signal.aborted) resolve(); else exec.signal.addEventListener('abort', () => { resolve() }, { once: true }) }); return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph: programGraph() })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Observe interruption', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Observe interruption' } } })
    await vi.waitFor(() => { expect(invocations).toBe(1) })
    await serviceFiber.dispose()
    await ctx.plugin(ProductionStudio)
    const run = await current(ctx, agent.id)
    expect(run.tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('unknown')
    await expect(ctx.productionStudio.resume(agent.id, { runId: run.id, revision: run.revision, nodeId: 'baseline' })).rejects.toThrow('cannot be replayed')
    await expect(ctx.productionStudio.reconcile(agent.id, { runId: run.id, revision: run.revision, nodeId: 'baseline' })).rejects.toThrow('No Host provider')
    expect(invocations).toBe(1)
  })

  it('stops a repair loop at its immutable budget and never announces delivery', async () => {
    const { ctx, agent, input, receipt, root } = await harness()
    let invocations = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'External failed geometry result', parameters: { node: { type: 'string' } }, execute: async () => { invocations++; return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
    await writeFixtureCase(root, true)
    const graph = programGraph(); graph.maxExecutions = 4
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Repair within budget', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Repair within budget' } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).tasks.some(task => task.message.includes('budget exhausted'))).toBe(true) })
    const run = await current(ctx, agent.id)
    expect(run.executions).toBe(4)
    expect(run.phase).toBe('blocked')
    expect(run.tasks.find(task => task.nodeId === 'delivery')?.phase).toBe('waiting')
    expect(invocations).toBe(2)
  })

  it('restricts a reserved child before its first request, denies late tools, and leaves its parent usable', async () => {
    const { ctx, agent, adapter } = await harness(['hang'], false)
    const children = new ProductionChildren(ctx)
    const calls: string[] = []
    const register = (name: string, owner = ctx) => owner.tools.register(defineContentToolFixture({
      name, description: 'Observed fixture capability', parameters: {},
      execute: async () => { calls.push(name); return [{ type: 'text', text: 'fixture' }] },
    }))
    register('read_only')
    register('source_write')
    register('rhino_modify')
    const controller = new AbortController()
    const child = await children.start({ provider: 'fork', label: 'Restricted inspection',
      request: { parent: agent, prompt: [{ type: 'text', text: 'Inspect only' }] }, signal: controller.signal }, { runId: 'run', nodeId: 'inspect', attempt: 1 }, ['read_only'])
    try {
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
      expect(adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['read_only'])
      const local = ctx.agents.get(child.childId)
      if (!local) throw new Error('Expected live reserved child')
      register('late_global_write')
      register('late_child_write', local.ctx)
      const execute = (name: string, owner = local) => ctx.tools.execute({
        callId: ToolCallId(`policy-${name}`), name, arguments: {}, agent: owner, signal: new AbortController().signal,
      })
      for (const name of ['source_write', 'rhino_modify', 'late_global_write', 'late_child_write']) {
        const denied = await execute(name).catch(() => ({ isError: true }))
        expect(denied.isError).toBe(true)
      }
      expect(calls).toEqual([])
      await execute('read_only')
      await execute('source_write', agent)
      expect(calls).toEqual(['read_only', 'source_write'])
      controller.abort()
      expect((await child.result).stopReason).toBe('aborted')
    } finally { await child.dispose() }
  })

  it('retains PTC transport for allowed capabilities while denying nested writes and an empty tool list', async () => {
    const { ctx, agent, adapter } = await harness(['hang', 'hang'], false, 'ptc')
    await ctx.plugin(PolicyPtcRuntime)
    const children = new ProductionChildren(ctx)
    const calls: string[] = []
    ctx.tools.register(defineTool({ name: 'read_only', description: 'Read fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { calls.push('read'); return 'read' } }))
    const runtime = ctx.ptcRuntime as PolicyPtcRuntime
    for (const tools of [['read_only'], []]) {
      const child = await children.start({ provider: 'fork', label: 'PTC inspection',
        request: { parent: agent, prompt: [{ type: 'text', text: 'Inspect' }] }, signal: new AbortController().signal },
      { runId: 'ptc-run', nodeId: 'inspect', attempt: 1 }, tools)
      try {
        await vi.waitFor(() => expect(adapter.requests).toHaveLength(tools.length ? 1 : 2))
        expect(adapter.requests.at(-1)!.tools?.map(tool => tool.name) ?? []).toEqual(tools.length ? ['run_code'] : [])
        const local = ctx.agents.get(child.childId)
        if (!local) throw new Error('Expected PTC child')
        local.ctx.tools.register(defineTool({ name: 'late_child_write', description: 'Write fixture', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async () => { calls.push('write'); return 'write' } }))
        runtime.behavior = async (request) => {
          const bindings = request.bindings[0]!.functions
          expect(await bindings.read_only!({})).toBe('read')
          await expect(bindings.late_child_write!({})).rejects.toThrow('does not allow')
          return { logs: [] }
        }
        const result = await ctx.tools.execute({ callId: ToolCallId(`ptc-${tools.length}`), name: 'run_code',
          arguments: { code: 'fixture', description: 'Read fixture' }, agent: local, signal: new AbortController().signal })
        expect(result.isError).toBe(tools.length === 0)
      } finally { await child.dispose() }
    }
    expect(calls).toEqual(['read'])
  })

  it('rejects an activation that never confirms the reserved child and disposes that exact receipt', async () => {
    const { ctx, agent, adapter } = await harness(undefined, false)
    const children = new ProductionChildren(ctx)
    const dispose = vi.fn(async () => {})
    const start = vi.spyOn(ctx.subagents, 'startActivation').mockResolvedValue({
      childId: SessionId('wrong-child'), result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose,
    })
    try {
      await expect(children.start({ provider: 'fork', label: 'Bound task',
        request: { parent: agent, prompt: [] }, signal: new AbortController().signal }, { runId: 'run', nodeId: 'inspect', attempt: 1 }, [])).rejects.toThrow('reserved identity')
      expect(dispose).toHaveBeenCalledOnce()
      expect(adapter.requests).toEqual([])
    } finally { start.mockRestore() }
  })

  it('refuses production child cold resume and direct reopen after settlement and policy reload', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('inspected')], false)
    await ctx.plugin(TestSessionQuery)
    let children: ProductionChildren | undefined
    let owner = await ctx.plugin({ inject: ['tools', 'agents', 'subagents'], apply: (inner) => { children = new ProductionChildren(inner) } })
    if (!children) throw new Error('Expected policy owner')
    const child = await children.start({ provider: 'fork', label: 'One-shot inspection',
      request: { parent: agent, prompt: [{ type: 'text', text: 'Inspect once' }] }, signal: new AbortController().signal },
    { runId: 'run', nodeId: 'inspect', attempt: 1 }, [])
    expect((await child.result).stopReason).toBe('completed')
    await child.dispose()
    for (let reload = 0; reload < 2; reload++) {
      await expect(ctx.subagents.sendMessage(agent, child.childId, [{ type: 'text', text: 'Continue with more tools' }],
        { signal: new AbortController().signal })).rejects.toThrow(/no matching live run attempt|unavailable|continuation|follow-up/)
      await expect(ctx.agents.resume({ resumeSessionId: child.childId, parentAgent: agent,
        agentOptions: { provider: 'mock', model: 'mock' } })).rejects.toThrow('no matching live run attempt')
      await owner.dispose()
      owner = await ctx.plugin({ inject: ['tools', 'agents', 'subagents'], apply: (inner) => { children = new ProductionChildren(inner) } })
    }
    expect(adapter.requests).toHaveLength(1)
  })

  it('refuses a reserved-namespace child without a surviving run attempt before any first request', async () => {
    const { ctx, agent, adapter } = await harness(undefined, false)
    await ctx.plugin({ inject: ['tools', 'agents', 'subagents'], apply: (inner) => { new ProductionChildren(inner) } })
    await expect(ctx.agents.create({ sessionId: SessionId('production-studio-child-interrupted-before-publication'),
      parentAgent: agent, agentOptions: { provider: 'mock', model: 'mock' } })).rejects.toThrow('no matching live run attempt')
    expect(adapter.requests).toHaveLength(0)
  })

  it('runs an actual forked child but rejects its claim of completed objective checks', async () => {
    const { ctx, agent, input, adapter, root } = await harness()
    const graph = programGraph()
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    const geometry = graph.nodes.find(node => node.id === 'geometry')
    if (!baseline || !geometry) throw new Error('Expected default nodes')
    baseline.kind = 'agent'; baseline.config = { prompt: 'Analyze the supplied task', tools: [] }
    graph.maxExecutions = 2
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Require actual proof', goalContractAcknowledged: true, input: { ...input, caseFilePath: join(root, 'unbound.json'), deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Require actual proof' } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'geometry')?.message).toContain('Objective check failed') })
    const run = await current(ctx, agent.id)
    expect(adapter.requests).toHaveLength(1)
    const childId = run.tasks.find(task => task.nodeId === 'baseline')?.childSessionId
    expect(childId).toBeDefined()
    expect(run.phase).not.toBe('complete')
  })

  it('rejects removing an objective gate or rewiring directly to delivery', async () => {
    const graph = programGraph()
    graph.edges.push({ id: 'bypass', fromNode: 'goal', fromPort: 'failure', toNode: 'repair', toPort: 'input' })
    expect(() => validateProductionGraph(graph)).not.toThrow()
    const bypass = graph.nodes.find(node => node.id === 'baseline')
    if (!bypass) throw new Error('Expected baseline')
    bypass.outputs.push({ id: 'bypass', type: 'delivery', outlet: 'success' })
    graph.edges.push({ id: 'direct-delivery', fromNode: 'baseline', fromPort: 'bypass', toNode: 'delivery', toPort: 'input' })
    expect(() => validateProductionGraph(graph)).toThrow('bypasses mandatory')
  })

  it('retains concurrent failure arrivals while a shared repair invocation is running', async () => {
    const { ctx, agent, input } = await harness()
    let releaseSecond = (): void => {}
    const second = new Promise<void>((resolve) => { releaseSecond = resolve })
    let releaseRepair = (): void => {}
    const firstRepair = new Promise<void>((resolve) => { releaseRepair = resolve })
    let repairs = 0
    ctx.tools.register(defineContentToolFixture({ name: 'fixture_check', description: 'Independent failing checks', parameters: { node: { type: 'string' } }, execute: async (args) => { if ((args as { node: string }).node === 'right') await second; return [{ type: 'text', text: '{"okay":false}' }] } }))
    ctx.tools.register(defineContentToolFixture({ name: 'fixture_repair', description: 'Controlled shared worker', parameters: {}, execute: async () => { repairs++; if (repairs === 1) await firstRepair; return [{ type: 'text', text: '{"settled":true}' }] } }))
    const graph = programGraph()
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    if (!baseline) throw new Error('Expected baseline')
    baseline.config.breakBefore = true
    for (const id of ['left', 'right']) {
      graph.nodes.push({ id, label: id, kind: 'gate', x: 0, y: 0, inputs: [], outputs: [{ id: 'failure', type: 'issue', outlet: 'failure' }], maxAttempts: 1, config: { toolName: 'fixture_check', arguments: { node: id }, evidenceToolName: 'fixture_check', evidencePath: 'okay', expected: true } })
      graph.edges.push({ id: `${id}-shared`, fromNode: id, fromPort: 'failure', toNode: 'shared', toPort: 'input' })
    }
    graph.nodes.push({ id: 'shared', label: 'Shared repair', kind: 'program', x: 0, y: 0, inputs: [{ id: 'input', type: 'issue' }], outputs: [], maxAttempts: 2, config: { toolName: 'fixture_repair', arguments: {} } })
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Retain both repairs', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Retain both repairs' } } })
    await vi.waitFor(() => { expect(repairs).toBe(1) })
    releaseSecond()
    await vi.waitFor(async () => { const run = await current(ctx, agent.id); const task = run.tasks.find(item => item.nodeId === 'shared'); expect(task?.phase).toBe('running'); expect(task?.queued).toHaveLength(1) })
    releaseRepair()
    await vi.waitFor(async () => { expect(repairs).toBe(2); const task = (await current(ctx, agent.id)).tasks.find(item => item.nodeId === 'shared'); expect(task?.phase).toBe('complete'); expect(task?.attempts).toBe(2); expect(task?.queued).toHaveLength(0) })
  })

  it('joins each port in FIFO order even when a faster port queues two generations', async () => {
    const { ctx, agent, input } = await harness()
    const releases = new Map<string, () => void>()
    const barriers = new Map(['left2', 'left3', 'right2'].map(id => [id, new Promise<void>((resolve) => { releases.set(id, resolve) })]))
    let releaseJoin = (): void => {}
    const joinBarrier = new Promise<void>((resolve) => { releaseJoin = resolve })
    const joined: string[][] = []
    ctx.tools.register(defineContentToolFixture({ name: 'fixture_source', description: 'Controlled input stream', parameters: { label: { type: 'string' } }, execute: async (args, exec) => { const label = (args as { label: string }).label; const abort = (): void => { releases.get(label)?.() }; exec.signal.addEventListener('abort', abort, { once: true }); try { await barriers.get(label); return [{ type: 'text', text: JSON.stringify({ label }) }] } finally { exec.signal.removeEventListener('abort', abort) } } }))
    ctx.tools.register(defineContentToolFixture({ name: 'fixture_join', description: 'FIFO port join', parameters: { left: { type: 'string' }, right: { type: 'string' } }, execute: async (args, exec) => { const pair = args as { left: string; right: string }; joined.push([pair.left, pair.right]); const abort = (): void => { releaseJoin() }; exec.signal.addEventListener('abort', abort, { once: true }); try { if (joined.length === 1) await joinBarrier; return [{ type: 'text', text: JSON.stringify(pair) }] } finally { exec.signal.removeEventListener('abort', abort) } } }))
    const graph = programGraph(); graph.maxConcurrent = 6
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    if (!baseline) throw new Error('Expected baseline')
    baseline.config.breakBefore = true
    for (const label of ['left1', 'right1', 'left2', 'left3', 'right2']) {
      graph.nodes.push({ id: label, label, kind: 'program', x: 0, y: 0, inputs: [], outputs: [{ id: 'success', type: 'analysis', outlet: 'success' }], maxAttempts: 1, config: { toolName: 'fixture_source', arguments: { label } } })
      graph.edges.push({ id: `${label}-join`, fromNode: label, fromPort: 'success', toNode: 'join', toPort: label.startsWith('left') ? 'left' : 'right' })
    }
    graph.nodes.push({ id: 'join', label: 'Join streams', kind: 'program', x: 0, y: 0, inputs: [{ id: 'left', type: 'analysis' }, { id: 'right', type: 'analysis' }], outputs: [], maxAttempts: 3, config: { toolName: 'fixture_join', arguments: { left: '$upstream.left.label', right: '$upstream.right.label' } } })
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    const objective = 'Preserve each FIFO input stream'
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
    await vi.waitFor(async () => { expect(joined, JSON.stringify((await current(ctx, agent.id)).tasks)).toEqual([['left1', 'right1']]) })
    for (const [index, label] of ['left2', 'left3', 'right2'].entries()) {
      releases.get(label)?.()
      await vi.waitFor(async () => { expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'join')?.queued).toHaveLength(index + 1) })
    }
    releaseJoin()
    await vi.waitFor(async () => { expect(joined).toEqual([['left1', 'right1'], ['left2', 'right2']]); expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'join')?.phase).toBe('waiting') })
    const task = (await current(ctx, agent.id)).tasks.find(item => item.nodeId === 'join')
    expect(task?.attempts).toBe(2)
    expect(task?.incoming?.['left']?.data).toEqual({ label: 'left3' })
    expect(task?.incoming?.['right']).toBeUndefined()
  })

  it('repairs a proven rejection before native dispatch instead of quarantining it', async () => {
    const { ctx, agent, input, receipt } = await harness()
    const dispose = ctx.productionStudio.registerNativeBoundaryProvider(['finalize_candidate'])
    ctx.effect(() => dispose)
    let invocations = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'Trusted native boundary fixture', parameters: { node: { type: 'string' } }, execute: async (_args, exec) => { invocations++; if (invocations === 1) throw new Error('Fixture revision is stale'); await ctx.productionStudio.noteNativeDispatch(exec.callId); return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph: programGraph() })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Repair a known rejection', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Repair a known rejection' } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).phase).toBe('complete') }, { timeout: 10_000 })
    const run = await current(ctx, agent.id)
    expect(run.history.some(item => item.nodeId === 'baseline' && item.phase === 'blocked')).toBe(true)
    expect(run.history.some(item => item.phase === 'unknown')).toBe(false)
    expect(invocations).toBe(3)
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
  })

  it('routes actual read schema rejection to failure before dispatch while executed errors remain unknown', async () => {
    const { ctx, agent, input, root } = await harness()
    applyReadTool(ctx, { limit: 10, maxLineLength: 100, maxBytes: 1024, streamMinSize: 1024 })
    await writeFile(join(root, 'read-probe.txt'), 'Actual filesystem read after a known rejection\n')
    let readDispatches = 0
    let uncertainDispatches = 0
    ctx.on('tools/execute', (exec, next) => { if (exec.name === 'read') readDispatches++; return next() })
    ctx.tools.register(defineContentToolFixture({ name: 'uncertain_fixture', description: 'An executed operation with no known result', parameters: {}, execute: async () => { uncertainDispatches++; throw new Error('Operation returned no receipt') } }))
    const graph = programGraph()
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    if (!baseline) throw new Error('Expected baseline')
    baseline.config.breakBefore = true
    graph.nodes.push(
      { id: 'invalid-read', label: 'Invalid read', kind: 'program', x: 0, y: 300, inputs: [], outputs: [{ id: 'failure', type: 'issue', outlet: 'failure' }], maxAttempts: 1, config: { toolName: 'read', arguments: { path: 'read-probe.txt' } } },
      { id: 'correct-read', label: 'Correct read', kind: 'program', x: 100, y: 300, inputs: [{ id: 'input', type: 'issue' }], outputs: [], maxAttempts: 1, config: { toolName: 'read', arguments: { file_path: 'read-probe.txt' } } },
      { id: 'uncertain', label: 'Actually executed error', kind: 'program', x: 0, y: 400, inputs: [], outputs: [], maxAttempts: 1, config: { toolName: 'uncertain_fixture', arguments: {} } },
    )
    graph.edges.push({ id: 'correct-invalid-read', fromNode: 'invalid-read', fromPort: 'failure', toNode: 'correct-read', toPort: 'input' })
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    const objective = 'Classify schema failures without replaying executed work'
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
    await vi.waitFor(async () => {
      const run = await current(ctx, agent.id)
      expect(run.tasks.find(task => task.nodeId === 'correct-read')?.phase).toBe('complete')
      expect(run.tasks.find(task => task.nodeId === 'uncertain')?.phase).toBe('unknown')
    })
    const run = await current(ctx, agent.id)
    const invalid = run.tasks.find(task => task.nodeId === 'invalid-read')
    expect(invalid?.phase).toBe('blocked')
    expect(invalid?.evidence.at(-1)?.data).toMatchObject({ dispatch: 'not-dispatched', stage: 'arguments' })
    expect(run.history.some(item => item.nodeId === 'invalid-read' && item.phase === 'unknown')).toBe(false)
    expect(run.tasks.find(task => task.nodeId === 'correct-read')?.output).toMatchObject({ lines: [{ number: 1, text: 'Actual filesystem read after a known rejection' }] })
    expect(readDispatches).toBe(1)
    expect(uncertainDispatches).toBe(1)
  })

  it('quarantines a dispatched native error across reload and blocks ordinary native calls', async () => {
    const { ctx, agent, input, serviceFiber } = await harness()
    const dispose = ctx.productionStudio.registerNativeBoundaryProvider(['finalize_candidate'])
    ctx.effect(() => dispose)
    let invocations = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'Uncertain native boundary fixture', parameters: { node: { type: 'string' } }, execute: async (_args, exec) => { invocations++; await ctx.productionStudio.noteNativeDispatch(exec.callId); throw new Error('Fixture native timeout') } }))
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph: programGraph() })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Keep dispatched outcome unknown', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Keep dispatched outcome unknown' } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('unknown') })
    await serviceFiber.dispose()
    await ctx.plugin(ProductionStudio)
    expect((await ctx.productionStudio.get(agent.id)).error).toContain('unresolved native')
    const result = await ctx.tools.execute({ callId: ToolCallId('ordinary-retry'), name: 'finalize_candidate', arguments: { node: 'ordinary' }, agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(invocations).toBe(1)
    expect((await current(ctx, agent.id)).phase).toBe('unknown')
  })

  it('treats successful AEA envelopes with unresolved geometry as unknown rather than repairing', async () => {
    const { ctx, agent, input } = await harness()
    let invocations = 0
    ctx.tools.register(defineTool({ name: 'finalize_candidate', description: 'Actual AEA string-value unknown contract fixture', parameters: { node: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }, execute: async () => { invocations++; return '{"workflow":{"stage":"verification_unknown"}}' } }))
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph: programGraph() })
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective: 'Do not replay unknown geometry', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Do not replay unknown geometry' } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).phase).toBe('unknown') })
    expect(invocations).toBe(1)
    expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'repair')?.attempts).toBe(0)
    expect((await ctx.productionStudio.get(agent.id)).error).toContain('uncertain result')
  })

  it('cannot clear native serialization by editing node resources or by calling outside a graph', async () => {
    const { ctx, agent, receipt } = await harness()
    let releaseFirst = (): void => {}
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    let active = 0
    let peak = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'Exclusive native fixture', parameters: { node: { type: 'string' } }, execute: async () => { calls++; active++; peak = Math.max(peak, active); if (calls === 1) await first; active--; return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
    const one = ctx.tools.execute({ callId: ToolCallId('native-one'), name: 'finalize_candidate', arguments: { node: 'one' }, agent, signal: new AbortController().signal })
    await vi.waitFor(() => { expect(calls).toBe(1) })
    const two = ctx.tools.execute({ callId: ToolCallId('native-two'), name: 'finalize_candidate', arguments: { node: 'two' }, agent, signal: new AbortController().signal })
    releaseFirst()
    const results = await Promise.all([one, two])
    expect(results.every(result => !result.isError)).toBe(true)
    expect(calls).toBe(2)
    expect(peak).toBe(1)
  })

  it('rejects replacing protected validators, frozen goal bindings, or unconfirmed objectives', async () => {
    const { ctx, agent, input } = await harness()
    for (const change of [(node: ProductionGraph['nodes'][number]): void => { node.config.toolName = 'fixture_always_true' }, (node: ProductionGraph['nodes'][number]): void => { node.config.arguments = { deliveryGoal: { kind: 'verified-drawings' } } }]) {
      const graph = programGraph()
      const gate = graph.nodes.find(node => node.id === 'goal')
      if (!gate) throw new Error('Expected goal')
      change(gate)
      await expect(ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph }))
        .rejects.toThrow(/mandatory|cannot be removed or weakened/)
    }
    await expect(ctx.productionStudio.start(agent.id, { graphVersion: 1, objective: 'One piece and zero welds', goalContractAcknowledged: false, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'One piece and zero welds' } } })).rejects.toThrow()
    await expect(ctx.productionStudio.start(agent.id, { graphVersion: 1, objective: 'One piece and zero welds', goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Any drawing' } } })).rejects.toThrow('objective')
  })

  it('requires the original four protected gates even if custom gates advertise the same certifications', async () => {
    const graph = programGraph()
    graph.edges = graph.edges.filter(edge => edge.id !== 'main-0')
    let previous = 'baseline'
    for (const [index, certification] of (['geometry', 'manufacturing', 'files', 'goal'] as const).entries()) {
      const id = `fake-${certification}`
      graph.nodes.push({ id, label: id, kind: 'gate', x: 0, y: 0, inputs: [{ id: 'input', type: index === 0 ? 'candidate' : 'delivery' }], outputs: [{ id: 'success', type: 'delivery', outlet: 'success' }], maxAttempts: 1, config: { certification, toolName: 'always_true', evidenceToolName: 'always_true', evidencePath: 'passed', expected: true } })
      graph.edges.push({ id: `bypass-${index}`, fromNode: previous, fromPort: 'success', toNode: id, toPort: 'input' })
      previous = id
    }
    graph.edges.push({ id: 'fake-delivery', fromNode: previous, fromPort: 'success', toNode: 'delivery', toPort: 'input' })
    expect(() => validateProductionGraph(graph)).toThrow('bypasses mandatory')
  })

  it('recovers an in-flight run independently from a second run that had only ready work', async () => {
    const { ctx, agent, root, serviceFiber, input, receipt } = await harness()
    let calls = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'Cancellable recovery fixture', parameters: { node: { type: 'string' } }, execute: async (_args, exec) => { calls++; await new Promise<void>((resolve) => { if (exec.signal.aborted) resolve(); else exec.signal.addEventListener('abort', () => { resolve() }, { once: true }) }); return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph: programGraph() })
    for (const objective of ['First native run', 'Second ready run']) await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
    await vi.waitFor(() => { expect(calls).toBe(1) })
    const path = join(root, 'state/production_studio.json')
    const crashedState = await readFile(path, 'utf8')
    await serviceFiber.dispose()
    await writeFile(path, crashedState)
    await ctx.plugin(ProductionStudio)
    const recovered = await ctx.productionStudio.get(agent.id)
    expect(recovered.runs[0]?.phase).toBe('unknown')
    expect(recovered.runs[1]?.phase).toBe('paused')
    expect(recovered.runs[1]?.tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('ready')
    expect(calls).toBe(1)
  })

  it('leases controlled review-document mutation through a trusted declaration', async () => {
    const { ctx, agent } = await harness()
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['open_review_result']))
    let dispatched = false
    ctx.tools.register(defineContentToolFixture({ name: 'open_review_result', description: 'Controlled document boundary fixture', parameters: {}, execute: async (_args, exec) => { await ctx.productionStudio.noteNativeDispatch(exec.callId); dispatched = true; return [{ type: 'text', text: '{"opened":true}' }] } }))
    const result = await ctx.tools.execute({ callId: ToolCallId('review-display'), name: 'open_review_result', arguments: {}, agent, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(dispatched).toBe(true)
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
  })

  it.each(['verify_stage_plan', 'revalidate_candidate', 'future_native_command'])('leases provider-declared %s and retains its exact Session event identity', async (name) => {
    const { ctx, agent, adapter } = await harness([toolCallResponse('declared-native-call', name, {}), textResponse('Recorded the tool result')])
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['create_case', name]))
    let dispatched = 0
    ctx.tools.register(defineContentToolFixture({ name, description: 'Provider-declared native fixture', parameters: {}, execute: async (_args, exec) => {
      await expect(ctx.productionStudio.noteNativeDispatch(ToolCallId('another-call'))).rejects.toThrow('No matching trusted')
      await ctx.productionStudio.noteNativeDispatch(exec.callId)
      dispatched++
      return [{ type: 'text', text: '{"accepted":true}' }]
    } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Execute the declared fixture' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(dispatched).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    const invocation = ctx.sessionProjections.stateOf(agent.session, 'productionNativeInvocations')!['declared-native-call']
    expect(invocation).toMatchObject({ callCount: 1, resultCount: 1, callEvent: { data: { name } },
      resultEvent: { data: { message: { isError: false } } } })
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
    await expect(ctx.productionStudio.noteNativeDispatch(ToolCallId('declared-native-call'))).rejects.toThrow('No matching trusted')
  })

  it('retains undeclared call identities across replay before a provider activates', async () => {
    const { ctx, agent, serviceFiber } = await harness([toolCallResponse('late-call', 'future_native_command', {}), textResponse('Recorded')])
    ctx.tools.register(defineContentToolFixture({ name: 'future_native_command', description: 'Late provider fixture', parameters: {}, execute: async () => [{ type: 'text', text: 'recorded' }] }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Record the call' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await serviceFiber.dispose()
    await ctx.plugin(ProductionStudio)
    const before = ctx.sessionProjections.stateOf(agent.session, 'productionNativeInvocations')!['late-call']
    expect(before).toMatchObject({ callCount: 1, resultCount: 1 })
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['future_native_command']))
    expect(ctx.sessionProjections.stateOf(agent.session, 'productionNativeInvocations')!['late-call']).toEqual(before)
  })

  it('keeps provider-declared unknown operations quarantined across Sessions while XML failures stay independent', async () => {
    const { ctx, agent, execute } = await harness()
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['verify_stage_plan'], { readOnlyToolNames: ['rhino_api_lookup'] }))
    let nativeCalls = 0, lookupCalls = 0
    ctx.tools.register(defineContentToolFixture({ name: 'verify_stage_plan', description: 'Unresolved declared operation', parameters: {}, execute: async (_args, exec) => {
      await ctx.productionStudio.noteNativeDispatch(exec.callId); nativeCalls++; throw new Error('Native outcome is unknown')
    } }))
    ctx.tools.register(defineContentToolFixture({ name: 'rhino_api_lookup', description: 'Local XML reader', parameters: {}, execute: async () => { lookupCalls++; throw new Error('XML unavailable') } }))
    expect((await execute('rhino_api_lookup', 'lookup-before')).isError).toBe(true)
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
    expect((await execute('verify_stage_plan', 'uncertain-declared')).isError).toBe(true)
    await expect(ctx.productionStudio.noteNativeDispatch(ToolCallId('uncertain-declared'))).rejects.toThrow('No matching trusted')
    expect((await execute('rhino_api_lookup', 'lookup-during')).isError).toBe(true)
    const other = await ctx.agents.create({ sessionId: SessionId('other-native-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
    const blocked = await ctx.tools.execute({ callId: ToolCallId('foreign-native'), name: 'verify_stage_plan', arguments: {}, agent: other.agent, signal: new AbortController().signal })
    expect(blocked.isError).toBe(true)
    expect(nativeCalls).toBe(1); expect(lookupCalls).toBe(2)
    expect((await ctx.productionStudio.get(agent.id)).error).toContain('uncertain result')
  })

  it('disposes exact native and readonly declarations without weakening another provider', async () => {
    const { ctx, agent, execute } = await harness()
    const service = ctx.productionStudio
    const declarations = await ctx.plugin((inner) => {
      inner.effect(() => service.registerNativeBoundaryProvider(['future_native_command'], { readOnlyToolNames: ['rhino_api_lookup'] }))
    })
    const nativeConflict = ctx.productionStudio.registerNativeBoundaryProvider(['rhino_api_lookup'])
    let markers = 0
    for (const name of ['future_native_command', 'rhino_api_lookup']) ctx.tools.register(defineContentToolFixture({ name, description: 'Declaration disposal fixture', parameters: {}, execute: async (_args, exec) => {
      await ctx.productionStudio.noteNativeDispatch(exec.callId); markers++; return [{ type: 'text', text: 'marked' }]
    } }))
    expect((await execute('rhino_api_lookup', 'conflicting-native')).isError).toBe(false)
    nativeConflict(); nativeConflict()
    expect((await execute('rhino_api_lookup', 'readonly-has-no-marker')).isError).toBe(true)
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
    expect((await execute('future_native_command', 'declared-before-dispose')).isError).toBe(false)
    await declarations.dispose()
    expect((await execute('future_native_command', 'disposed-native')).isError).toBe(true)
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
    // After the readonly provider unloads, legacy rhino_* inference is conservative again.
    expect((await execute('rhino_api_lookup', 'fallback-native')).isError).toBe(true)
    expect((await ctx.productionStudio.get(agent.id)).error).toContain('uncertain result')
    expect(markers).toBe(2)
  })

  it('schedules declared readonly XML work while the exclusive native resource is occupied', async () => {
    const { ctx, agent, input, receipt } = await harness()
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['future_native_command'], { readOnlyToolNames: ['rhino_api_lookup'] }))
    let release = (): void => {}, started = false
    const held = new Promise<void>((resolve) => { release = resolve })
    ctx.tools.register(defineContentToolFixture({ name: 'future_native_command', description: 'Held native fixture', parameters: {}, execute: async (_args, exec) => {
      await ctx.productionStudio.noteNativeDispatch(exec.callId); started = true; await held; return [{ type: 'text', text: JSON.stringify(receipt) }]
    } }))
    ctx.tools.register(defineContentToolFixture({ name: 'rhino_api_lookup', description: 'Independent local XML fixture', parameters: {}, execute: async () => [{ type: 'text', text: 'Local XML' }] }))
    const graph = programGraph()
    graph.nodes.find(node => node.id === 'baseline')!.config = { toolName: 'future_native_command', arguments: {} }
    graph.nodes.push({ id: 'xml', label: 'Local XML', kind: 'program', x: 0, y: 0, inputs: [], outputs: [], maxAttempts: 1, config: { toolName: 'rhino_api_lookup', arguments: {} } })
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    const objective = 'Inspect docs without occupying native geometry'
    try {
      await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
      await vi.waitFor(async () => { expect(started).toBe(true); expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'xml')?.phase).toBe('complete') })
      expect((await current(ctx, agent.id)).tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('running')
    } finally { release() }
  })

  it('captures live tool receipts from a real child before settling its delivery branch', async () => {
    const { ctx, agent, receipt, input, adapter } = await harness([
      toolCallResponse('live-child-finalize', 'finalize_candidate', { node: 'baseline' }), textResponse('Current child tool completed'),
    ])
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) throw new Error('Expected fixture receipt object')
    ctx.tools.register(defineTool({ name: 'finalize_candidate', description: 'Actual live child receipt', parameters: { node: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }, execute: async () => JSON.stringify({ ...receipt, case: { caseId: input.caseId, caseFilePath: input.caseFilePath } }) }))
    const graph = programGraph()
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    if (!baseline) throw new Error('Expected baseline')
    baseline.kind = 'agent'; baseline.config = { prompt: 'Produce actual current tool evidence', tools: ['finalize_candidate'] }
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    const objective = 'Deliver with current child evidence'
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
    await vi.waitFor(async () => { expect((await current(ctx, agent.id)).phase).toBe('complete') })
    const run = await current(ctx, agent.id)
    expect(adapter.requests).toHaveLength(2)
    expect(run.tasks.find(task => task.nodeId === 'baseline')?.evidence.filter(item => item.kind === 'tool'))
      .toMatchObject([{ toolName: 'finalize_candidate', data: { case: { caseId: input.caseId, caseFilePath: input.caseFilePath } } }])
    expect(run.tasks.find(task => task.nodeId === 'delivery')?.certificates.toSorted()).toEqual(['files', 'geometry', 'goal', 'manufacturing'])
  })

  it('does not reuse a real receipt inherited from an earlier completed parent turn', async () => {
    const { ctx, agent, receipt, input, adapter } = await harness([toolCallResponse('historical-finalize', 'finalize_candidate', { node: 'old-parent-case' }), textResponse('Old parent work completed'), textResponse('Child has no new tools or case')])
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) throw new Error('Expected fixture receipt object')
    ctx.tools.register(defineTool({ name: 'finalize_candidate', description: 'Historical real string receipt', parameters: { node: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }, execute: async () => JSON.stringify({ ...receipt, case: { caseId: input.caseId, caseFilePath: input.caseFilePath } }) }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish the old parent task' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && !event.data.message.isError)).toBe(true)
    const graph = programGraph()
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    if (!baseline) throw new Error('Expected baseline')
    baseline.kind = 'agent'; baseline.config = { prompt: 'Analyze this new objective with no tool evidence', tools: [] }
    graph.maxExecutions = 2
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: 1, graph })
    const objective = 'Require a new case binding'
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
    await vi.waitFor(async () => { const run = await current(ctx, agent.id); expect(run.tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('complete'); expect(run.tasks.find(task => task.nodeId === 'geometry')?.phase).toBe('unknown') })
    const run = await current(ctx, agent.id)
    expect(adapter.requests).toHaveLength(3)
    expect(run.tasks.find(task => task.nodeId === 'baseline')?.evidence.filter(item => item.kind === 'tool')).toHaveLength(0)
    expect(run.phase).not.toBe('complete')
  })
})
