/** Pure graph editing and preview validation; Host validation remains authoritative. */
import type { ProductionGraph, ProductionNode, ProductionPortType } from '@deepseek-ai/dsh-production-studio/types'

/** Editor-supported artifact vocabulary. */
export const PORT_TYPES: readonly ProductionPortType[] = ['input', 'candidate', 'geometry', 'manufacturing', 'files', 'delivery', 'issue', 'unknown', 'analysis']
/** Fixed node width shared by port geometry and the CSS layout. */
export const NODE_WIDTH = 236
/** One preview-validation finding for localized presentation. */
export interface GraphFinding { kind: 'endpoint' | 'mismatch' | 'self' | 'disconnected' | 'delivery' | 'gate'; node?: string; gate?: 'geometry' | 'manufacturing' | 'files' | 'goal' }

/**
 * Preview typed connections and mandatory proof paths without granting evidence.
 * @param graph - Current editable draft.
 * @returns findings that prevent saving or starting this draft.
 */
export function graphFindings(graph: ProductionGraph): GraphFinding[] {
  const findings: GraphFinding[] = []
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  for (const edge of graph.edges) {
    const output = nodes.get(edge.fromNode)?.outputs.find(port => port.id === edge.fromPort)
    const input = nodes.get(edge.toNode)?.inputs.find(port => port.id === edge.toPort)
    if (output === undefined || input === undefined) findings.push({ kind: 'endpoint' })
    else if (output.type !== input.type) findings.push({ kind: 'mismatch' })
    if (edge.fromNode === edge.toNode) findings.push({ kind: 'self' })
  }
  const entries = graph.nodes.filter(node => !graph.edges.some(edge => edge.toNode === node.id))
  for (const node of graph.nodes) {
    if (node.inputs.some(port => port.type !== 'input') && !graph.edges.some(edge => edge.toNode === node.id)) {
      findings.push({ kind: 'disconnected', node: node.label })
    }
  }
  const deliveries = graph.nodes.filter(node => node.kind === 'delivery')
  if (deliveries.length === 0) findings.push({ kind: 'delivery' })
  for (const gate of ['geometry', 'manufacturing', 'files', 'goal'] as const) {
    const certifiers = graph.nodes.filter(node => node.kind === 'gate' && node.config.certification === gate)
    const seen = new Set(entries.map(node => node.id))
    const queue = [...seen]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const edge of graph.edges.filter(item => item.fromNode === current)) {
        const node = nodes.get(edge.fromNode)
        if (node?.config.certification === gate && node.outputs.find(port => port.id === edge.fromPort)?.outlet === 'success') continue
        if (!seen.has(edge.toNode)) { seen.add(edge.toNode); queue.push(edge.toNode) }
      }
    }
    if (certifiers.length === 0 || deliveries.some(node => seen.has(node.id))) findings.push({ kind: 'gate', gate })
  }
  return findings
}

/**
 * Insert a uniquely named, evidence-free Agent or supplementary gate.
 * @param graph - Current graph whose node names reserve identities.
 * @param kind - The added responsibility.
 * @param label - Localized initial name, editable by the user.
 * @returns a detached node ready for explicit connection and configuration.
 */
export function newNode(graph: ProductionGraph, kind: 'agent' | 'gate' | 'human', label: string): ProductionNode {
  let sequence = 1
  while (graph.nodes.some(node => node.id === `${kind}-${sequence}`)) sequence++
  const index = graph.nodes.length
  return {
    id: `${kind}-${sequence}`, label, kind,
    x: 40 + (index % 3) * 290, y: 40 + Math.floor(index / 3) * 240,
    inputs: [{ id: 'input', type: 'candidate' }],
    outputs: [
      { id: 'success', type: 'candidate', outlet: 'success' },
      { id: 'failure', type: 'issue', outlet: 'failure' },
    ],
    maxAttempts: 3, config: {},
  }
}

/**
 * Convert one saved node port to the canvas's stable coordinates.
 * @param node - Node placement.
 * @param port - Named input or output.
 * @param output - Whether the endpoint is on the right edge.
 * @returns the port center in graph coordinates.
 */
export function portPoint(node: ProductionNode, port: string, output: boolean): { x: number; y: number } {
  const index = (output ? node.outputs : node.inputs).findIndex(item => item.id === port)
  return { x: node.x + (output ? NODE_WIDTH : 0), y: node.y + 88 + Math.max(0, index) * 26 }
}

/**
 * Route forward and repair edges through row gaps rather than across node titles.
 * @param start - Output-port center.
 * @param end - Input-port center.
 * @returns an SVG path in graph coordinates.
 */
export function edgePath(start: { x: number; y: number }, end: { x: number; y: number }): string {
  if (end.x > start.x && Math.abs(end.y - start.y) < 40) {
    const distance = Math.max(24, (end.x - start.x) / 2)
    return `M${start.x},${start.y} C${start.x + distance},${start.y} ${end.x - distance},${end.y} ${end.x},${end.y}`
  }
  const rail = end.y > start.y ? Math.floor((start.y + end.y) / 2) : Math.min(start.y, end.y) - 100
  return `M${start.x},${start.y} H${start.x + 24} V${rail} H${end.x - 24} V${end.y} H${end.x}`
}


/**
 * Insert an extra read-only evidence gate on one existing success route.
 * @param graph - Editable future graph.
 * @param targetId - Node whose forward input receives the new gate.
 * @param label - Localized new-gate label.
 * @returns Connected draft and new node, or null when no supported evidence check exists.
 */
export function insertGateBefore(
  graph: ProductionGraph, targetId: string, label: string,
): { graph: ProductionGraph; node: ProductionNode } | null {
  const target = graph.nodes.find(item => item.id === targetId)
  const incoming = graph.edges.filter(edge => edge.toNode === targetId && graph.nodes
    .find(node => node.id === edge.fromNode)?.outputs.find(port => port.id === edge.fromPort)?.outlet === 'success')
  if (target === undefined || incoming.length === 0
    || new Set(incoming.map(item => `${item.fromNode}:${item.fromPort}`)).size !== incoming.length) return null
  const edge = incoming[0]
  if (edge === undefined) return null
  const input = target.inputs.find(port => port.id === edge.toPort)
  const checks = target.kind === 'gate' ? [target, ...graph.nodes] : graph.nodes
  const checker = checks.find(item => item.kind === 'gate' && item.config.toolName === 'production_aea_evidence'
    && (item.inputs.some(port => port.type === input?.type) || item.outputs.some(port => port.type === input?.type)))
  if (input === undefined || input.type === 'input' || checker === undefined
    || incoming.some(item => item.toPort !== edge.toPort)) return null
  const { certification, ...settings } = checker.config
  void certification
  const node = { ...newNode(graph, 'gate', label), maxAttempts: 1,
    x: target.x, y: target.y + 230, config: structuredClone(settings),
    inputs: [{ id: 'input', type: input.type }],
    outputs: [{ id: 'success', type: input.type, outlet: 'success' as const },
      { id: 'failure', type: 'issue' as const, outlet: 'failure' as const },
      { id: 'unknown', type: 'unknown' as const, outlet: 'unknown' as const }],
  }
  const edges = graph.edges.map(item => incoming.some(source => source.id === item.id)
    ? { ...item, toNode: node.id, toPort: 'input' } : item)
  edges.push({ id: `${node.id}-success`, fromNode: node.id, fromPort: 'success', toNode: targetId, toPort: edge.toPort })
  const repair = graph.nodes.find(item => item.id === 'repair' && item.inputs.some(port => port.type === 'issue'))
  const repairInput = repair?.inputs.find(port => port.type === 'issue')
  if (repair !== undefined && repairInput !== undefined) edges.push({ id: `${node.id}-failure`, fromNode: node.id,
    fromPort: 'failure', toNode: repair.id, toPort: repairInput.id })
  return { graph: { ...graph, nodes: [...graph.nodes, node], edges }, node }
}
