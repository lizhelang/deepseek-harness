/** Future-only graph edits preserve admitted operations and consumed routes. */
import type { ProductionGraph, ProductionNode, ProductionRun } from './types.ts'

function execution(node: ProductionNode): string {
  const { x, y, label, ...settings } = node
  void x; void y; void label
  return JSON.stringify(settings)
}

/**
 * Reject graph edits that rewrite past execution or add another executor.
 * @param run - Current run with durable admission and consumed routes.
 * @param graph - Submitted future-only graph revision.
 */
export function validateConversationEdit(run: ProductionRun, graph: ProductionGraph): void {
  if (graph.maxExecutions > run.graph.maxExecutions || graph.maxConcurrent !== 1) throw new Error('Conversation execution budgets cannot increase and concurrency stays one')
  if (graph.nodes.filter(node => !graph.edges.some(edge => edge.toNode === node.id)).length !== 1) throw new Error('A conversation graph requires exactly one entry')
  for (const node of graph.nodes) {
    for (const outlet of ['success', 'failure', 'unknown']) if (graph.edges.filter(edge => edge.fromNode === node.id && node.outputs.find(port => port.id === edge.fromPort)?.outlet === outlet).length > 1) throw new Error('Conversation routes cannot fork into parallel executors')
    if (node.kind === 'agent' && !['baseline', 'manufacture', 'repair'].includes(node.id)) throw new Error('This conversation adapter has no completion contract for the new agent node')
    if (node.config.provider || node.config.model) throw new Error('Conversation nodes inherit the current chat model; model overrides require a separate supported executor')
    if (node.kind === 'program' || node.kind === 'gate' && node.config.toolName !== 'production_aea_evidence') throw new Error('Conversation automatic nodes may only execute read-only AEA evidence checks')
    const previous = run.graph.nodes.find(item => item.id === node.id)
    if (previous && node.maxAttempts > previous.maxAttempts) throw new Error('Node retry budgets cannot increase')
  }
  const admitted = run.tasks.filter(item => item.admitted === true || item.attempts > 0
    || ['running', 'human', 'paused', 'unknown'].includes(item.phase))
  for (const task of admitted) {
    const previous = run.graph.nodes.find(item => item.id === task.nodeId)
    const next = graph.nodes.find(item => item.id === task.nodeId)
    if (!previous || !next || execution(previous) !== execution(next)) throw new Error(`Admitted node ${task.nodeId} is immutable; edit a future node`)
    const outgoing = (value: ProductionGraph): string => JSON.stringify(value.edges
      .filter(edge => edge.fromNode === task.nodeId).sort((a, b) => a.id.localeCompare(b.id)))
    if (outgoing(run.graph) !== outgoing(graph)) throw new Error(`Consumed route from ${task.nodeId} is immutable`)
  }
}
