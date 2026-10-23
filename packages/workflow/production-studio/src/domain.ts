/** Persisted production state decoding and the fixed AEA conversation graph. */
import { z } from 'zod'
import type { ProductionGraph, ProductionNode, ProductionState } from './types.ts'

const portType = z.enum(['input', 'candidate', 'geometry', 'manufacturing', 'files', 'delivery', 'issue', 'unknown', 'analysis'])
const certificate = z.enum(['geometry', 'manufacturing', 'files', 'goal'])
const port = z.object({ id: z.string().min(1), type: portType, outlet: z.enum(['success', 'failure', 'unknown']).optional() }).strict()
const config = z.object({
  prompt: z.string().optional(), provider: z.string().optional(), model: z.string().optional(),
  toolName: z.string().optional(), arguments: z.json().optional(),
  evidencePath: z.string().optional(), evidenceToolName: z.string().optional(),
  expected: z.json().optional(), certification: certificate.optional(), question: z.string().optional(),
  filePaths: z.array(z.string().min(1)).optional(), fileHashes: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
  breakBefore: z.boolean().optional(), breakAfter: z.boolean().optional(), reconcileToolName: z.string().optional(),
}).strict()
const node = z.object({
  id: z.string().min(1), label: z.string().min(1), kind: z.enum(['agent', 'program', 'gate', 'human', 'delivery']),
  x: z.number(), y: z.number(), inputs: z.array(port), outputs: z.array(port),
  maxAttempts: z.number().int().min(1).max(100), resource: z.string().optional(), protected: z.boolean().optional(), config,
}).strict()
const graphSchema = z.object({
  version: z.number().int().min(0), name: z.string().min(1), nodes: z.array(node).min(1).max(80),
  edges: z.array(z.object({
    id: z.string().min(1), fromNode: z.string(), fromPort: z.string(), toNode: z.string(), toPort: z.string(),
  }).strict()).max(240),
  maxExecutions: z.number().int().min(1).max(1000), maxConcurrent: z.number().int().min(1).max(16),
}).strict()
const evidence = z.object({ kind: z.enum(['tool', 'file', 'human', 'agent']), nodeId: z.string(), attempt: z.number().int().nonnegative(), toolName: z.string().optional(), data: z.json(), observedAt: z.number() }).strict()
const phase = z.enum(['waiting', 'ready', 'running', 'human', 'paused', 'blocked', 'unknown', 'complete', 'skipped'])
const token = z.record(z.string(), z.object({ data: z.json(), evidence: z.array(evidence), certificates: z.array(certificate) }))
const task = z.object({ admitted: z.boolean().optional(), nodeId: z.string(), phase, attempts: z.number().int().nonnegative(), message: z.string(), output: z.json().optional(), evidence: z.array(evidence), certificates: z.array(certificate), childSessionId: z.string().optional(), startedAt: z.number().optional(), updatedAt: z.number(), incoming: token.optional(), queued: z.array(token).optional(), breakpoint: z.enum(['before', 'after']).optional(), breakpointReleased: z.boolean().optional(), pendingOutlet: z.enum(['success', 'failure', 'unknown']).optional(), operationId: z.string().optional(), settledOperationId: z.string().optional() }).strict()
const budget = z.object({ used: z.number().int().nonnegative(), limit: z.number().int().nonnegative() }).strict()
const caseView = z.object({
  caseId: z.string().min(1), inputVersion: z.string().min(1), revision: z.number().int().nonnegative(),
  phase: z.enum(['intake', 'baseline', 'improve', 'compare', 'manufacture', 'delivered']), stage: z.string(),
  candidates: budget, hostCalls: budget.optional(),
  rows: z.array(z.object({
    candidateId: z.string().min(1), parentCandidateId: z.string().optional(), kind: z.string(), hypothesis: z.string().optional(),
    searchStatus: z.string(), searchScore: z.number().optional(),
    searchCounts: z.object({ pieces: z.number(), bends: z.number(), welds: z.number() }).strict().optional(),
    manufacturing: z.object({ status: z.enum(['passed', 'failed', 'unknown', 'running']), score: z.number().optional(), pieces: z.number().optional() }).strict().optional(),
    failure: z.string().optional(),
  }).strict()).max(200),
  bestSearchCandidateId: z.string().optional(), bestManufacturingCandidateId: z.string().optional(), stopReason: z.string().optional(),
  finishBlockers: z.array(z.string()), nextActions: z.array(z.string()),
  attention: z.object({ kind: z.enum(['unknown', 'blocked', 'budget']), message: z.string() }).strict().optional(),
  delivery: z.object({
    candidateId: z.string().min(1),
    files: z.array(z.object({ kind: z.string(), path: z.string().min(1), sha256: z.string().min(1) }).strict()),
  }).strict().optional(),
  observedAt: z.number(),
}).strict()
const run = z.object({ id: z.string().min(1), revision: z.number().int().positive(), objective: z.string().min(1), graph: graphSchema, phase: z.enum(['active', 'paused', 'blocked', 'unknown', 'complete']), executions: z.number().int().nonnegative(), input: z.json(), tasks: z.array(task), history: z.array(z.object({ nodeId: z.string(), attempt: z.number().int().nonnegative(), phase, message: z.string(), time: z.number() })), createdAt: z.number(), updatedAt: z.number(), mode: z.enum(['conversation', 'scheduled']).optional(), binding: z.object({ provider: z.string().min(1), key: z.string().min(1) }).strict().optional(), case: caseView.optional() }).strict()
const stateSchema = z.object({
  format: z.literal(1), revision: z.number().int().nonnegative(), graph: graphSchema,
  conversationProvider: z.string().min(1).optional(), runs: z.array(run).max(50),
  pendingCheckpoints: z.array(run).max(1000).optional(),
}).strict()

/**
 * Decode an untrusted persisted snapshot before using it.
 * @param value - Session event data.
 * @returns validated domain data.
 */
export function decodeProductionState(value: unknown): ProductionState { return stateSchema.parse(value) as ProductionState }

/**
 * Whether a persisted run graph has the fixed conversation nodes, settings and edges.
 * Graphs edited before graph editing was removed may carry human checks, breakpoints,
 * custom gates or rerouted edges that this executor no longer runs.
 * @param graph - a run's stored graph.
 * @returns true when only labels, positions, agent prompts, tool lists and budgets differ from the fixed graph.
 */
export function isFixedConversationGraph(graph: ProductionGraph): boolean {
  // Decoding fixes key order, so stored and freshly built graphs compare equal.
  const structure = (value: ProductionGraph): string => {
    const decoded = graphSchema.parse(value) as ProductionGraph
    return JSON.stringify({
      nodes: decoded.nodes.map(({ x, y, label, config: { prompt, tools, ...config }, ...node }) => {
        void x; void y; void label; void prompt; void tools
        return { ...node, config }
      }),
      edges: decoded.edges,
    })
  }
  return structure(graph) === structure(createConversationGraph(graph.maxExecutions, []))
}

/**
 * Construct the fixed AEA conversation graph. Agent nodes run in the parent conversation;
 * protected gates read the AEA ledger before delivery.
 * @param maxExecutions - whole-run execution cap, never expanded by the adapter.
 * @param toolNames - actual profile tools visible to the parent conversation.
 * @returns the linear graph with its repair route.
 */
export function createConversationGraph(maxExecutions: number, toolNames: readonly string[]): ProductionGraph {
  const outputs = (type: ProductionNode['inputs'][number]['type']): ProductionNode['outputs'] => [{ id: 'success', type, outlet: 'success' }, { id: 'failure', type: 'issue', outlet: 'failure' }, { id: 'unknown', type: 'unknown', outlet: 'unknown' }]
  const agent = (id: 'baseline' | 'manufacture' | 'repair', label: string, x: number, y: number, input: ProductionNode['inputs'][number]['type'], output: ProductionNode['inputs'][number]['type'], prompt: string): ProductionNode => ({ id, label, kind: 'agent', x, y, inputs: [{ id: 'input', type: input }], outputs: outputs(output), maxAttempts: 3, resource: 'Rhino', config: { prompt, tools: [...toolNames] } })
  const gate = (id: string, label: string, x: number, y: number, input: ProductionNode['inputs'][number]['type'], output: ProductionNode['inputs'][number]['type'], certification: NonNullable<ProductionNode['config']['certification']>, evidencePath: string): ProductionNode => ({ id, label, kind: 'gate', x, y, inputs: [{ id: 'input', type: input }], outputs: outputs(output), maxAttempts: 8, protected: true, config: { certification, evidencePath, expected: true, toolName: 'production_aea_evidence', evidenceToolName: 'production_aea_evidence', arguments: { caseId: '$input.caseId', caseFilePath: '$input.caseFilePath', stage: certification, deliveryGoal: '$input.deliveryGoal' } } })
  const nodes: ProductionNode[] = [
    agent('baseline', '基础方案', 40, 40, 'input', 'candidate', '在原输入和冻结预算内提出、验证、比较并优化方案。按当前 Host nextActions 完成有界搜索与制造反馈；不要自行提前 user_requested 停止，不把理论分数当制造成本。'),
    gate('geometry', '几何检查', 330, 40, 'candidate', 'geometry', 'geometry', 'geometryVerified'),
    agent('manufacture', '制造补偿与出图', 620, 40, 'geometry', 'manufacturing', '按当前 Host nextActions 完成所有必需候选的真实制造、当前图纸与制造成本比较。保留最佳合法方案，明确失败再走修复，未知只对账不重放。'),
    gate('manufacturing', '制造检查', 40, 280, 'manufacturing', 'manufacturing', 'manufacturing', 'manufacturingVerified'),
    gate('file-check', '保存文件检查', 330, 280, 'manufacturing', 'files', 'files', 'fileReadbackVerified'),
    gate('goal', '交付目标判定', 620, 280, 'files', 'delivery', 'goal', 'goalSatisfied'),
    { id: 'delivery', label: '交付', kind: 'delivery', x: 620, y: 530, inputs: [{ id: 'input', type: 'delivery' }], outputs: [], maxAttempts: 1, protected: true, config: {} },
    agent('repair', '修复或必要优化', 40, 530, 'issue', 'candidate', '读取精确失败证据，在原冻结预算内提出真正不同的修复。继续实际验证、搜索、制造与比较，不修改参数、预算、原模型或用文字声称通过。'),
  ]
  const chain = ['baseline', 'geometry', 'manufacture', 'manufacturing', 'file-check', 'goal', 'delivery']
  const edges = chain.slice(1).map((id, index) => ({ id: `main-${index}`, fromNode: chain[index] ?? '', fromPort: 'success', toNode: id, toPort: 'input' }))
  for (const item of nodes.filter(item => item.kind !== 'delivery' && item.id !== 'repair')) edges.push({ id: `repair-${item.id}`, fromNode: item.id, fromPort: 'failure', toNode: 'repair', toPort: 'input' })
  edges.push({ id: 'repair-return', fromNode: 'repair', fromPort: 'success', toNode: 'geometry', toPort: 'input' })
  return { version: 1, name: 'AEA 对话执行流程', nodes, edges, maxExecutions, maxConcurrent: 1 }
}
