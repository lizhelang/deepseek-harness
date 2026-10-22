/** Test-only native-provider and model fixtures over the real Loader-mounted production service. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-production-studio'
import { writeFixtureCase } from '../fixture-case.ts'

/** Calls the native fixture once for the baseline and once for manufacturing, then answers. */
class ProductionAdapter extends LlmAdapter {
  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return { provider, id, name: id } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const count = options.messages.filter(item => item.role === 'tool').length
    if (count < 2) {
      const id = ToolCallId(`production-call-${count}`), name = 'finalize_candidate', argumentsText = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Delivered the Loader fixture drawings' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Test plugin identity. */
export const name = 'seed-production'
/** Required composed services. */
export const inject = ['productionStudio', 'llm', 'tools']

/**
 * Run one real conversation workflow with isolated external-provider and model fixtures.
 * @param ctx - actual Loader-composed Host.
 * @returns after installing the fixtures.
 */
export async function apply(ctx: Context): Promise<void> {
  const { input, receipt } = await writeFixtureCase(process.cwd())
  const objective = 'Deliver the Loader fixture drawings'
  ctx.llm.registerAdapter(['production-fixture'], new ProductionAdapter())
  ctx.tools.register(defineContentToolFixture({ name: 'finalize_candidate', description: 'External native provider fixture', parameters: {}, execute: async (_args, exec) => { await ctx.productionStudio.noteNativeDispatch(exec.callId); return [{ type: 'text', text: JSON.stringify(receipt) }] } }))
  ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['finalize_candidate']))
  ctx.effect(() => ctx.productionStudio.registerConversationWorkflow({ id: 'loader-production', toolNames: ['finalize_candidate'], appliesTo: () => true,
    start: () => ({ key: input.caseId, objective, input: { ...input, deliveryGoal: { kind: 'verified-drawings', objectiveText: objective } } }),
    observe: () => ({ outlet: 'success' }) }))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const run = (await ctx.productionStudio.get(agent.id)).runs.at(-1)
    if (run?.phase === 'complete') process.stdout.write(`${JSON.stringify({ type: 'production_result', run })}\n`)
  })
}
