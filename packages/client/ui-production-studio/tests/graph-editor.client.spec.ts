import { describe, expect, it } from 'vitest'
import { edgePath, graphFindings, newNode, portPoint } from '../src/client/graph-editor.ts'
import { graph } from './fixtures.ts'

describe('editable typed workflow', () => {
  it('requires objective gates on every delivery path', () => {
    const draft = graph()
    expect(graphFindings(draft)).toEqual([])
    draft.edges.push({ id: 'bypass', fromNode: 'baseline', fromPort: 'success', toNode: 'delivery', toPort: 'input' })
    expect(graphFindings(draft)).toEqual(expect.arrayContaining([{ kind: 'mismatch' }, { kind: 'gate', gate: 'geometry' }, { kind: 'gate', gate: 'files' }]))
    draft.edges.pop()
    draft.nodes = draft.nodes.filter(node => node.id !== 'geometry')
    expect(graphFindings(draft)).toContainEqual({ kind: 'endpoint' })
  })
  it('adds removable evidence-free responsibilities and preserves stable names', () => {
    const draft = graph()
    const first = newNode(draft, 'agent', 'Independent reviewer')
    expect(first.config.certification).toBeUndefined()
    expect(first.inputs[0]?.type).toBe(first.outputs[0]?.type)
    draft.nodes.push(first)
    expect(newNode(draft, 'agent', 'Second reviewer').id).toBe('agent-2')
    expect(newNode(draft, 'human', 'Decision').config.certification).toBeUndefined()
    expect(graphFindings(draft)).toContainEqual({ kind: 'disconnected', node: 'Independent reviewer' })
  })
  it('locates port centers and routes repair paths through a gap', () => {
    const baseline = graph().nodes[0]!
    expect(portPoint(baseline, 'success', true)).toEqual({ x: 276, y: 128 })
    expect(edgePath({ x: 276, y: 128 }, { x: 330, y: 128 })).toContain('C')
    expect(edgePath({ x: 276, y: 528 }, { x: 330, y: 128 })).toContain('V28')
  })
})
