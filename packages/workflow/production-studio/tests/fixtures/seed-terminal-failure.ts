/** Loader fixture for a Host capability terminal in the owning conversation. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-production-studio'

const message = '开发侧能力受阻：no_executable_next_action；不要求用户二选一。'
class TerminalAdapter extends LlmAdapter {
  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return { provider, id, name: id } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const count = options.messages.filter(item => item.role === 'tool').length
    if (count < 2) {
      const id = ToolCallId(`terminal-call-${count}`), name = 'terminal_host_receipt', argumentsText = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: message } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Loader fixture identity. */
export const name = 'seed-terminal-failure'
/** Real composition dependencies. */
export const inject = ['productionStudio', 'llm', 'tools']
/**
 * Supply deterministic external Host and model replies to the real executor.
 * @param ctx - Loader-composed Host.
 */
export function apply(ctx: Context): void {
  let calls = 0
  const receipt = { workflow: { caseId: 'terminal-case', control: { status: 'capability_blocked',
    terminal: true, reasonCode: 'no_executable_next_action', nextActions: [] },
  continuationPolicy: { userChoiceRequired: false } } }
  ctx.llm.registerAdapter(['terminal-fixture'], new TerminalAdapter())
  ctx.effect(() => ctx.productionStudio.registerConversationWorkflow({ id: 'terminal-fixture',
    toolNames: ['terminal_host_receipt'], appliesTo: () => true,
    start: () => ({ key: 'terminal-case', objective: 'Preserve the actual capability failure', input: { caseId: 'terminal-case' } }),
    observe: () => ({ outlet: 'failure', terminal: true, message }) }))
  ctx.tools.register(defineTool({ name: 'terminal_host_receipt', description: 'External Host terminal fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls++; return JSON.stringify(receipt) } }))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const run = (await ctx.productionStudio.get(agent.id)).runs.at(-1)
    process.stdout.write(`${JSON.stringify({ type: 'terminal_failure_result', calls, phase: run?.phase,
      taskPhase: run?.tasks[0]?.phase, executions: run?.executions, humanWait: run?.tasks.some(task => task.phase === 'human'),
      repairPhase: run?.tasks.find(task => task.nodeId === 'repair')?.phase })}\n`)
  })
}
