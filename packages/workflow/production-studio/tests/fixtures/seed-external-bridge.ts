/** Test-only contract observer; the external bridge source is never copied into this repository. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-production-studio'

/** Isolated external bridge test plugin identity. */
export const name = 'seed-external-bridge'
/** Required actual Host services. */
export const inject = ['productionStudio', 'tools', 'agents', 'loader', 'llm']

/**
 * Observe pre-dispatch rejection and an actual trusted marker before a stubbed Host failure.
 * @param ctx - Loader-composed real service context.
 * @returns after installing the observer.
 */
export async function apply(ctx: Context): Promise<void> {
  // Web creates its parent after the profile has activated. A configured
  // startup agent would publish before this external profile is mounted.
  const bridge = [...ctx.loader.entries()].find(entry => entry.options.id === 'actual-aea-bridge')
  if (!bridge?.fiber) throw new Error('The selected external AEA bridge did not mount')
  await bridge.fiber.await()
  ctx.llm.registerAdapter(['external-bridge'], new MockAdapter([
    toolCallResponse('external-create-case', 'create_case', { modelPath: join(process.cwd(), 'fixture.3dm') }),
    textResponse('The isolated Host stub stopped before native geometry.'),
  ]))
  const parent = await ctx.agents.create({ sessionId: SessionId('external-bridge-parent'),
    agentOptions: { provider: 'external-bridge', model: 'mock' }, meta: { cwd: process.cwd() } })
  ctx.effect(() => () => parent.dispose(), 'external bridge fixture parent')
  const observed = new Set<string>()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (observed.has(agent.id)) return next()
    observed.add(agent.id)
    for (const name of ['create_case', 'open_review_result', 'inspect_geometry', 'get_workpiece_configuration']) if (!ctx.tools.get(name, agent)) throw new Error(`Actual AEA bridge failed to register ${name}`)
    const result = await ctx.tools.execute({ callId: ToolCallId('external-invalid-review'), name: 'open_review_result', arguments: { caseId: 'fixture', candidateId: 'fixture', reportId: 'fixture', expectedDocumentSerial: 0 }, agent, signal: new AbortController().signal })
    if (!result.isError) throw new Error('Actual AEA bridge accepted an invalid native document identity')
    const state = await ctx.productionStudio.get(agent.id)
    if (state.error) throw new Error(`Known pre-dispatch rejection quarantined the real bridge: ${state.error}`)
    if (state.capabilities.conversation) for (const name of ['verify_stage_plan', 'revalidate_candidate', 'rhino_api_lookup']) {
      if (!ctx.tools.get(name, agent)) throw new Error(`Staged AEA bridge failed to register ${name}`)
    }
    process.stdout.write(`${JSON.stringify({ type: 'external_bridge_predispatch', registered: true, nativeDispatched: false,
      conversationProvider: state.capabilities.conversation?.provider ?? null })}\n`)
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.callId !== 'external-create-case') return next()
    if (!result.isError || !result.error.message.includes('EXTERNAL_AEA_HOST_STUB_REACHED'))
      throw new Error(`Actual create_case did not reach the isolated Host stub: ${JSON.stringify(result)}`)
    const stored = z.object({ tables: z.object({ native: z.object({ Rhino: z.object({
      operationId: z.literal('external-create-case'), toolName: z.literal('create_case'),
      sessionId: z.literal('external-bridge-parent'), markerSupported: z.literal(true), dispatched: z.literal(true), status: z.literal('unknown'),
    }) }) }) }).parse(JSON.parse(await readFile(join(process.cwd(), '.state', 'production_studio.json'), 'utf8')))
    process.stdout.write(`${JSON.stringify({ type: 'external_bridge_dispatch', lease: stored.tables.native.Rhino,
      actualNativeExecuted: false, hostStubReached: true })}\n`)
    return next()
  })
}
