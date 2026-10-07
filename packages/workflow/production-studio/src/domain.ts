/** Validated editor input and deterministic production graph rules. */
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
const task = z.object({ nodeId: z.string(), phase, attempts: z.number().int().nonnegative(), message: z.string(), output: z.json().optional(), evidence: z.array(evidence), certificates: z.array(certificate), childSessionId: z.string().optional(), startedAt: z.number().optional(), updatedAt: z.number(), incoming: token.optional(), queued: z.array(token).optional(), breakpoint: z.enum(['before', 'after']).optional(), breakpointReleased: z.boolean().optional(), pendingOutlet: z.enum(['success', 'failure', 'unknown']).optional(), operationId: z.string().optional() }).strict()
const stateSchema = z.object({ format: z.literal(1), revision: z.number().int().nonnegative(), graph: graphSchema, runs: z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive(), objective: z.string().min(1), graph: graphSchema, phase: z.enum(['active', 'paused', 'blocked', 'unknown', 'complete']), executions: z.number().int().nonnegative(), input: z.json(), tasks: z.array(task), history: z.array(z.object({ nodeId: z.string(), attempt: z.number().int().nonnegative(), phase, message: z.string(), time: z.number() })), createdAt: z.number(), updatedAt: z.number() }).strict()).max(50) }).strict()

/**
 * Decode an untrusted persisted snapshot before using it.
 * @param value - Session event data.
 * @returns validated domain data.
 */
export function decodeProductionState(value: unknown): ProductionState { return stateSchema.parse(value) as ProductionState }

/**
 * Reject invalid ports and paths that bypass objective delivery gates.
 * @param value - submitted draft.
 * @returns detached validated graph.
 */
export function validateProductionGraph(value: unknown): ProductionGraph {
  const graph = graphSchema.parse(value) as ProductionGraph
  const nodes = new Map(graph.nodes.map(item => [item.id, item]))
  if (nodes.size !== graph.nodes.length) throw new Error('Production node IDs must be unique')
  if (new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) throw new Error('Production edge IDs must be unique')
  for (const item of graph.nodes) {
    for (const ports of [item.inputs, item.outputs]) if (new Set(ports.map(p => p.id)).size !== ports.length) throw new Error(`Duplicate port on ${item.id}`)
    if (item.kind === 'human' && item.config.certification !== undefined) throw new Error('Human confirmation cannot certify objective geometry or files')
    if (item.config.certification !== undefined && item.kind !== 'gate') throw new Error('Only an objective gate may certify delivery evidence')
    if (item.kind === 'gate' && item.config.certification !== undefined && !item.config.evidencePath && !item.config.filePaths?.length) throw new Error(`Gate ${item.id} requires an objective evidence field or file readback`)
    if (item.kind === 'gate' && item.config.certification !== undefined && item.config.evidencePath && !item.config.evidenceToolName) throw new Error(`Gate ${item.id} requires the exact trusted tool receipt producer`)
    if (item.config.filePaths?.length && item.config.fileHashes?.length !== item.config.filePaths.length) throw new Error(`File readback on ${item.id} requires a paired SHA-256 for every file`)
  }
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNode)?.outputs.find(p => p.id === edge.fromPort)
    const to = nodes.get(edge.toNode)?.inputs.find(p => p.id === edge.toPort)
    if (!from || !to) throw new Error(`Missing endpoint on edge ${edge.id}`)
    if (from.type !== to.type) throw new Error(`Incompatible port types on edge ${edge.id}`)
    if (from.outlet === 'unknown') {
      const target = nodes.get(edge.toNode)
      if (target?.kind !== 'human') throw new Error('Unknown operations may only route to human inspection; the interrupted operation cannot be replayed')
    }
  }
  const deliveries = graph.nodes.filter(item => item.kind === 'delivery')
  if (!deliveries.length) throw new Error('Production graph requires a delivery node')
  const starts = graph.nodes.filter(item => !graph.edges.some(edge => edge.toNode === item.id))
  if (!starts.length) throw new Error('Production graph requires an entry node')
  const requiredGateIds = { geometry: 'geometry', manufacturing: 'manufacturing', files: 'file-check', goal: 'goal' }
  for (const required of ['geometry', 'manufacturing', 'files', 'goal'] as const) {
    const certifications = graph.nodes.filter(item => item.id === requiredGateIds[required] && item.protected === true && item.config.certification === required && item.config.toolName === 'production_aea_evidence' && item.config.evidenceToolName === 'production_aea_evidence')
    if (!certifications.length) throw new Error(`Missing mandatory ${required} gate`)
    const seen = new Set(starts.map(item => item.id))
    const queue = [...seen]
    while (queue.length) {
      const id = queue.shift()
      if (!id) break
      for (const edge of graph.edges.filter(item => item.fromNode === id)) {
        const from = nodes.get(id)
        if (certifications.some(gate => gate.id === from?.id) && from?.outputs.find(p => p.id === edge.fromPort)?.outlet === 'success') continue
        if (!seen.has(edge.toNode)) { seen.add(edge.toNode); queue.push(edge.toNode) }
      }
    }
    if (deliveries.some(item => seen.has(item.id))) throw new Error(`Delivery bypasses mandatory ${required} gate`)
  }
  return graph
}

/**
 * Construct the safe default production chain; its real tool bindings remain explicit.
 * @param maxExecutions - whole-run cap.
 * @param maxConcurrent - independent branch cap.
 * @returns editable default graph.
 */
export function createProductionGraph(maxExecutions: number, maxConcurrent: number): ProductionGraph {
  const outputs = (type: ProductionNode['inputs'][number]['type']): ProductionNode['outputs'] => [{ id: 'success', type, outlet: 'success' }, { id: 'failure', type: 'issue', outlet: 'failure' }, { id: 'unknown', type: 'unknown', outlet: 'unknown' }]
  const agent = (id: string, label: string, x: number, y: number, input: ProductionNode['inputs'][number]['type'], output: ProductionNode['inputs'][number]['type'], prompt: string): ProductionNode => ({ id, label, kind: 'agent', x, y, inputs: [{ id: 'input', type: input }], outputs: outputs(output), maxAttempts: 3, resource: 'Rhino', config: { prompt } })
  const gate = (id: string, label: string, x: number, y: number, input: ProductionNode['inputs'][number]['type'], output: ProductionNode['inputs'][number]['type'], certification: NonNullable<ProductionNode['config']['certification']>, evidencePath: string): ProductionNode => ({ id, label, kind: 'gate', x, y, inputs: [{ id: 'input', type: input }], outputs: outputs(output), maxAttempts: 8, protected: true, config: { certification, evidencePath, expected: true, toolName: 'production_aea_evidence', evidenceToolName: 'production_aea_evidence', arguments: { caseId: '$input.caseId', caseFilePath: '$input.caseFilePath', stage: certification, deliveryGoal: '$input.deliveryGoal' } } })
  const baseline = agent('baseline', '基础方案', 40, 40, 'input', 'candidate', 'The confirmed verified-drawings contract explicitly limits this initial stage to the baseline. Create or restore the supplied case, consult its real geometry, and submit one complete baseline using only frozen engineering and actual IDs. After that baseline is actually verified, record the already-confirmed limited trial scope with finish_search(reason="user_requested") using the current Host revision when legal. Do not run suggest_candidates, try_suggestion, submit_revision, resume_search, manufacturing or extra cost optimization in this node. If the baseline fails or is unknown, preserve its exact receipt and return it to the scheduler; do not invent a pass, increase budgets, or replay it. Preserve source models and user documents.')
  baseline.config.tools = ['create_case', 'begin_workflow', 'get_case_context', 'get_workpiece_configuration', 'inspect_geometry', 'inspect_candidate', 'submit_baseline', 'finish_search']
  const nodes: ProductionNode[] = [
    baseline,
    gate('geometry', '几何检查', 330, 40, 'candidate', 'geometry', 'geometry', 'geometryVerified'),
    agent('manufacture', '制造补偿与出图', 620, 40, 'geometry', 'manufacturing', 'Finalize the verified AEA candidate through the existing manufacturing workflow. This run has an explicitly confirmed verified-drawings goal contract: try the baseline first and deliver it if the declared conditions pass; optimize only when failure or an unmet declared condition makes it necessary. This is a limited trial scope, not an exhaustive or globally optimal search claim. Restore the actual baseline workflow state and, when Host nextActions permit, record that already-confirmed limited scope with finish_search(reason="user_requested") before real finalize_candidate and comparison. If manufacturing or a declared goal fails, follow legal Host nextActions to resume_search and repair within the original budget. Do not invent further user authorization, weaken gates, change frozen parameters, increase budgets, or replay unknown operations. Return actual Host receipts.'),
    gate('manufacturing', '制造检查', 40, 280, 'manufacturing', 'manufacturing', 'manufacturing', 'manufacturingVerified'),
    gate('file-check', '保存文件检查', 330, 280, 'manufacturing', 'files', 'files', 'fileReadbackVerified'),
    gate('goal', '交付目标判定', 620, 280, 'files', 'delivery', 'goal', 'goalSatisfied'),
    { id: 'delivery', label: '交付', kind: 'delivery', x: 620, y: 530, inputs: [{ id: 'input', type: 'delivery' }], outputs: [], maxAttempts: 1, protected: true, config: {} },
    agent('repair', '修复或必要优化', 40, 530, 'issue', 'candidate', 'Inspect the exact failed objective report. Make a distinct bounded repair through the existing AEA workflow and unchanged budget. Preserve the last legal candidate. Never fabricate native evidence or repeat unknown operations.'),
  ]
  const chain = ['baseline', 'geometry', 'manufacture', 'manufacturing', 'file-check', 'goal', 'delivery']
  const edges = chain.slice(1).map((id, index) => ({ id: `main-${index}`, fromNode: chain[index] ?? '', fromPort: 'success', toNode: id, toPort: 'input' }))
  for (const item of nodes.filter(item => item.kind !== 'delivery' && item.id !== 'repair')) edges.push({ id: `repair-${item.id}`, fromNode: item.id, fromPort: 'failure', toNode: 'repair', toPort: 'input' })
  edges.push({ id: 'repair-return', fromNode: 'repair', fromPort: 'success', toNode: 'geometry', toPort: 'input' })
  return validateProductionGraph({ version: 1, name: 'AEA 生产流程', nodes, edges, maxExecutions, maxConcurrent })
}
