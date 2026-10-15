/** Read-only responsibility ordering derived from real graph edges and node configuration. */
import type { ProductionGraph, ProductionNode } from '@deepseek-ai/dsh-production-studio/types'

/** Each lane names an execution owner; explanatory AEA details are not runtime nodes. */
export type ResponsibilityLane = 'model' | 'host' | 'aea'
/** A real graph node and whether it is reached only through a recovery route. */
export interface ResponsibilityRow { node: ProductionNode; recovery: boolean; canonical: boolean; lane: ResponsibilityLane }

/**
 * Project the success dependency order, followed by separately identified recovery nodes.
 * @param graph - Actual editable or execution graph; never modified.
 * @returns real nodes only, with AEA detail enabled only for the configured canonical chain.
 */
export function responsibilityRows(graph: ProductionGraph): ResponsibilityRow[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const success = graph.edges.filter(edge => nodes.get(edge.fromNode)?.outputs.find(port => port.id === edge.fromPort)?.outlet === 'success')
  const reachable = new Set<string>()
  const queue = graph.nodes.filter(node => !graph.edges.some(edge => edge.toNode === node.id)).map(node => node.id)
  while (queue.length) {
    const id = queue.shift()
    if (id === undefined || reachable.has(id)) continue
    reachable.add(id)
    queue.push(...success.filter(edge => edge.fromNode === id).map(edge => edge.toNode))
  }
  const canonical = isAeaResponsibilityGraph(graph)
  const ordered: ProductionNode[] = []
  const pending = graph.nodes.filter(node => reachable.has(node.id))
  while (pending.length) {
    const index = pending.findIndex(node => !success.some(edge => edge.toNode === node.id
      && pending.some(source => source.id === edge.fromNode)))
    ordered.push(...pending.splice(index < 0 ? 0 : index, 1))
  }
  ordered.push(...graph.nodes.filter(node => !reachable.has(node.id)))
  return ordered.map(node => ({ node, recovery: !reachable.has(node.id) && graph.edges.some(edge => edge.toNode === node.id && nodes.get(edge.fromNode)?.outputs.find(port => port.id === edge.fromPort)?.outlet !== 'success'), canonical,
    lane: node.kind === 'agent' ? 'model' : 'host' }))
}

/**
 * Recognize the configured AEA workflow without assigning AEA ownership to arbitrary programs.
 * @param graph - Current graph inspected without mutation.
 * @returns whether required trusted gates and the three canonical agent nodes are present.
 */
export function isAeaResponsibilityGraph(graph: ProductionGraph): boolean {
  if (!['baseline', 'manufacture', 'repair'].every(id => graph.nodes.some(node => node.id === id && node.kind === 'agent'))) return false
  return [['geometry', 'geometry'], ['manufacturing', 'manufacturing'], ['file-check', 'files'], ['goal', 'goal']].every(([id, certification]) => {
    const node = graph.nodes.find(node => node.id === id)
    return node?.kind === 'gate' && node.protected === true && node.config.certification === certification
      && node.config.toolName === 'production_aea_evidence' && node.config.evidenceToolName === 'production_aea_evidence'
  })
}
