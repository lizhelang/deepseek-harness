/** Loader fixture for exact native rejection settlement through the real conversation loop. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-production-studio'

class ReconciliationAdapter extends LlmAdapter {
  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return { provider, id, name: id } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.messages.some(message => message.role === 'tool')) {
      const argumentsText = '{ "caseId": "loader-case", "revision": 12 }'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('loader-native-call'), name: 'try_suggestion', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('loader-native-call'), name: 'try_suggestion', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Original rejection retained; no replay.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
/** Loader fixture identity. */
export const name = 'seed-native-reconciliation'
/** Real composition dependencies. */
export const inject = ['productionStudio', 'llm', 'tools', 'agents']
/**
 * Install only deterministic external Host and model fixtures.
 * @param ctx - actual Loader-composed Host.
 */
export function apply(ctx: Context): void {
  let calls = 0, reconciliations = 0
  ctx.llm.registerAdapter(['reconciliation-fixture'], new ReconciliationAdapter())
  const otherId = SessionId('other-preset-owner')
  let other: AgentHandle | undefined
  ctx.effect(() => () => other?.dispose())
  ctx.on('agent/pre-step', async (_step, next) => {
    other ??= await ctx.agents.create({ sessionId: otherId,
      agentOptions: { provider: 'reconciliation-fixture', model: 'reconciliation-fixture' }, meta: { cwd: process.cwd() } })
    return next()
  })
  ctx.effect(() => ctx.productionStudio.registerNativeReconciliationProvider({ id: 'other-session-host', toolNames: ['try_suggestion'],
    appliesTo: sessionId => sessionId === otherId, reconcile: async () => { throw new Error('Other Session provider must not resolve this call') } }))
  ctx.effect(() => ctx.productionStudio.registerConversationWorkflow({ id: 'loader-native', toolNames: ['try_suggestion'], appliesTo: () => true,
    start: () => ({ key: 'loader-case', objective: 'Retain the native rejection', input: { caseId: 'loader-case' } }), observe: () => undefined }))
  ctx.effect(() => ctx.productionStudio.registerNativeBoundaryProvider(['try_suggestion']))
  ctx.effect(() => ctx.productionStudio.registerNativeReconciliationProvider({ id: 'loader-host', toolNames: ['try_suggestion'], appliesTo: sessionId => sessionId !== otherId, reconcile: async (request) => {
    reconciliations++
    if (!request.resultEvent?.data.message.isError || request.operationId !== 'loader-native-call' || request.callEvent.data.arguments !== '{ "caseId": "loader-case", "revision": 12 }') throw new Error('Resolver lacks the original Session identity')
    return { sessionId: request.sessionId, operationId: request.operationId,
      toolName: request.toolName, argumentSha256: request.argumentSha256,
      outcome: 'rejected_before_native', receipt: { nativeEntered: false }, evidence: { ledger: 'fixture-authoritative-ledger' } }
  } }))
  ctx.tools.register(defineTool({ name: 'try_suggestion', description: 'Loader native Host fixture', parameters: { caseId: { type: 'string' }, revision: { type: 'number' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, exec) => { calls++; await ctx.productionStudio.noteNativeDispatch(exec.callId); throw new Error('Duplicate operation ID') } }))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const state = await ctx.productionStudio.get(agent.id), run = state.runs.at(-1)
    process.stdout.write(`${JSON.stringify({ type: 'native_reconciliation_result', otherSessionPresent: !!other && ctx.agents.get(otherId) === other.agent, phase: run?.phase, taskPhase: run?.tasks[0]?.phase,
      executions: run?.executions, attempts: run?.tasks[0]?.attempts, certificates: run?.tasks[0]?.certificates, calls, reconciliations, quarantine: !!state.error })}\n`)
  })
}
