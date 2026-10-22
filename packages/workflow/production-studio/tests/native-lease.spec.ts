import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ProductionStudio from '../src/index.ts'
import { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import { writeFixtureCase } from './fixture-case.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(script?: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FsLocal, { cwd: root })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'state') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const driver = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script ?? [textResponse('I am done; all checks passed')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('production-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const serviceFiber = await ctx.plugin(ProductionStudio)
  const { receipt } = await writeFixtureCase(root)
  const execute = (name: string, callId: string) => ctx.tools.execute({
    callId: ToolCallId(callId), name, arguments: {}, agent, signal: new AbortController().signal,
  })
  return { ctx, root, agent, adapter, serviceFiber, receipt, execute }
}

describe('native execution lease', () => {
  it('releases the lease after a proven rejection before native dispatch', async () => {
    const { ctx, agent, receipt, execute } = await harness()
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['finalize_candidate']))
    let invocations = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'Trusted native boundary fixture', parameters: {}, execute: async (_args, exec) => { invocations++; if (invocations === 1) throw new Error('Fixture revision is stale'); await ctx.productionStudio.noteNativeDispatch(exec.callId); return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
    expect((await execute('finalize_candidate', 'stale')).isError).toBe(true)
    expect((await ctx.productionStudio.get(agent.id)).error).toBeUndefined()
    expect((await execute('finalize_candidate', 'repaired')).isError).toBe(false)
    expect(invocations).toBe(2)
  })

  it('quarantines a dispatched native error across reload and blocks ordinary native calls', async () => {
    const { ctx, agent, serviceFiber, execute } = await harness()
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['finalize_candidate']))
    let invocations = 0
    ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'Uncertain native boundary fixture', parameters: {}, execute: async (_args, exec) => { invocations++; await ctx.productionStudio.noteNativeDispatch(exec.callId); throw new Error('Fixture native timeout') } }))
    expect((await execute('finalize_candidate', 'dispatched')).isError).toBe(true)
    await serviceFiber.dispose()
    await ctx.plugin(ProductionStudio)
    expect((await ctx.productionStudio.get(agent.id)).error).toContain('unresolved native')
    expect((await execute('finalize_candidate', 'ordinary-retry')).isError).toBe(true)
    expect(invocations).toBe(1)
  })

  it('treats successful AEA envelopes with unresolved geometry as unknown', async () => {
    const { ctx, agent, execute } = await harness()
    let invocations = 0
    ctx.tools.register(defineTool({ name: 'finalize_candidate', description: 'Actual AEA string-value unknown contract fixture', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { invocations++; return '{"workflow":{"stage":"verification_unknown"}}' } }))
    expect((await execute('finalize_candidate', 'unresolved')).isError).toBe(false)
    expect((await execute('finalize_candidate', 'blocked')).isError).toBe(true)
    expect(invocations).toBe(1)
    expect((await ctx.productionStudio.get(agent.id)).error).toContain('uncertain result')
  })

  it('runs declared readonly XML work while the exclusive native resource is occupied', async () => {
    const { ctx, receipt, execute } = await harness()
    ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['future_native_command'], { readOnlyToolNames: ['rhino_api_lookup'] }))
    let release = (): void => {}, started = false
    const held = new Promise<void>((resolve) => { release = resolve })
    ctx.tools.register(defineContentToolFixture({ name: 'future_native_command', description: 'Held native fixture', parameters: {}, execute: async (_args, exec) => {
      await ctx.productionStudio.noteNativeDispatch(exec.callId); started = true; await held; return [{ type: 'text', text: JSON.stringify(receipt) }]
    } }))
    ctx.tools.register(defineContentToolFixture({ name: 'rhino_api_lookup', description: 'Independent local XML fixture', parameters: {}, execute: async () => [{ type: 'text', text: 'Local XML' }] }))
    const native = execute('future_native_command', 'held-native')
    try {
      await vi.waitFor(() => { expect(started).toBe(true) })
      expect((await execute('rhino_api_lookup', 'xml')).isError).toBe(false)
    } finally { release() }
    expect((await native).isError).toBe(false)
  })

  it('serializes native calls made outside any workflow node', async () => {
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

})
