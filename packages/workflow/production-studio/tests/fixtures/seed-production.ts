/** Test-only native-provider fixture over the real Loader-mounted production service. */
import type { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { createProductionGraph } from '@deepseek-ai/dsh-production-studio'
import { writeFixtureCase } from '../fixture-case.ts'

/** Test plugin identity. */
export const name = 'seed-production'
/** Required composed services. */
export const inject = ['productionStudio', 'tools']

/**
 * Run one real workflow with an isolated external-provider fixture.
 * @param ctx - actual Loader-composed Host.
 * @returns after installing the fixture hook.
 */
export async function apply(ctx: Context): Promise<void> {
  const { input, receipt } = await writeFixtureCase(process.cwd())
  ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'External native provider fixture', parameters: {}, execute: async (_args, exec) => { await ctx.productionStudio.noteNativeDispatch(exec.callId); return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
  ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['finalize_candidate']))
  const started = new Set<string>()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (started.has(agent.id)) return next()
    started.add(agent.id)
    const graph = createProductionGraph(30, 2)
    for (const node of graph.nodes) if (node.kind === 'agent') { node.kind = 'program'; node.config = { toolName: 'finalize_candidate', arguments: {} }; delete node.resource }
    const initial = await ctx.productionStudio.get(agent.id)
    const saved = await ctx.productionStudio.saveGraph(agent.id, { expectedVersion: initial.graph.version, graph })
    const objective = 'Deliver the Loader fixture drawings'
    await ctx.productionStudio.start(agent.id, { graphVersion: saved.graph.version, objective, goalContractAcknowledged: true, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } })
    const controller = new AbortController()
    try {
      for await (const state of ctx.productionStudio.follow(agent.id, controller.signal)) {
        const run = state.runs.at(-1)
        if (!run) throw new Error('Loader fixture did not start a production run')
        if (run.phase === 'complete') { process.stdout.write(`${JSON.stringify({ type: 'production_result', run })}\n`); break }
        if (run.phase === 'blocked' || run.phase === 'unknown') throw new Error(`Loader production did not deliver: ${JSON.stringify(run.tasks)}`)
      }
    } finally { controller.abort() }
    return next()
  })
}
