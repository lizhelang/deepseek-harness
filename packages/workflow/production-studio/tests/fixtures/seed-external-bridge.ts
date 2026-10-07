/** Test-only contract observer; the external bridge source is never copied into this repository. */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-production-studio'

/** Isolated external bridge test plugin identity. */
export const name = 'seed-external-bridge'
/** Required actual Host services. */
export const inject = ['productionStudio', 'tools']

/**
 * Observe the actual bridge registry and reject one native request before dispatch.
 * @param ctx - Loader-composed real service context.
 * @returns after installing the observer.
 */
export function apply(ctx: Context): void {
  const observed = new Set<string>()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (observed.has(agent.id)) return next()
    observed.add(agent.id)
    for (const name of ['create_case', 'open_review_result', 'inspect_geometry', 'get_workpiece_configuration']) if (!ctx.tools.get(name, agent)) throw new Error(`Actual AEA bridge failed to register ${name}`)
    const result = await ctx.tools.execute({ callId: ToolCallId('external-invalid-review'), name: 'open_review_result', arguments: { caseId: 'fixture', candidateId: 'fixture', reportId: 'fixture', expectedDocumentSerial: 0 }, agent, signal: new AbortController().signal })
    if (!result.isError) throw new Error('Actual AEA bridge accepted an invalid native document identity')
    const state = await ctx.productionStudio.get(agent.id)
    if (state.error) throw new Error(`Known pre-dispatch rejection quarantined the real bridge: ${state.error}`)
    process.stdout.write(`${JSON.stringify({ type: 'external_bridge_result', registered: true, nativeDispatched: false })}\n`)
    return next()
  })
}
