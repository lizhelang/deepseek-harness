// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversationGraph } from '@deepseek-ai/dsh-production-studio/src/domain.ts'
import { ResponsibilityFlow } from '../src/client/ResponsibilityFlow.tsx'
import { isAeaResponsibilityGraph, responsibilityRows } from '../src/client/responsibility-flow.ts'
import { en, type ProductionStudioKey } from '../src/client/locales.ts'
import { graph } from './fixtures.ts'

const t = (key: ProductionStudioKey) => en[key]
afterEach(cleanup)

describe('three-lane responsibility projection', () => {
  it('orders real success nodes and separates repair without changing the graph', () => {
    const source = createConversationGraph(24, ['submit_baseline'])
    const before = JSON.stringify(source)
    expect(isAeaResponsibilityGraph(source)).toBe(true)
    expect(responsibilityRows(source).map(row => [row.node.id, row.recovery])).toEqual([
      ['baseline', false], ['geometry', false], ['manufacture', false], ['manufacturing', false],
      ['file-check', false], ['goal', false], ['delivery', false], ['repair', true],
    ])
    expect(JSON.stringify(source)).toBe(before)
  })

  it('shows recorded state only on its actual node, not on internal AEA explanations', () => {
    const view = render(<ResponsibilityFlow graph={createConversationGraph(24, ['submit_baseline'])} conversation
      tasks={[{ nodeId: 'baseline', phase: 'complete', attempts: 1, message: '', evidence: [], certificates: [], updatedAt: 1 }]}
      onSelect={vi.fn()} onAddGateBefore={vi.fn()} canAddGateBefore={() => false} t={t} />)
    expect(view.getByText('DSH model')).toBeTruthy()
    expect(view.getByText('Host flow control')).toBeTruthy()
    expect(view.getByText('AEA geometry code')).toBeTruthy()
    expect(view.container.querySelector('[data-responsibility-node="baseline"] [data-phase="complete"]')).not.toBeNull()
    expect(view.container.querySelector('[data-responsibility-node="geometry"] [data-phase="complete"]')).toBeNull()
    expect(view.container.querySelectorAll('[data-responsibility-explanation] [data-phase]')).toHaveLength(0)
    expect(view.getByText(en['responsibility.baselineConversation'])).toBeTruthy()
  })

  it('delegates selection and admitted gate insertion through real node IDs', () => {
    const onSelect = vi.fn(); const onAddGateBefore = vi.fn()
    const view = render(<ResponsibilityFlow graph={createConversationGraph(24, [])} tasks={[]} conversation
      onSelect={onSelect} onAddGateBefore={onAddGateBefore} canAddGateBefore={id => id === 'geometry'} t={t} />)
    fireEvent.click(view.getByRole('button', { name: '几何检查' }))
    expect(onSelect).toHaveBeenCalledWith('geometry')
    const gates = view.getAllByRole('button', { name: en['responsibility.addGate'] })
    expect((gates[0] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(gates[0]!)
    expect(onAddGateBefore).not.toHaveBeenCalled()
    fireEvent.click(gates[1]!)
    expect(onAddGateBefore).toHaveBeenCalledWith('geometry')
  })

  it('keeps arbitrary programs in the Host lane without invented AEA ownership', () => {
    const source = graph()
    source.nodes[0]!.kind = 'program'; source.nodes[0]!.config.toolName = 'custom_tool'
    expect(isAeaResponsibilityGraph(source)).toBe(false)
    const view = render(<ResponsibilityFlow graph={source} tasks={[]} conversation={false}
      onSelect={vi.fn()} onAddGateBefore={vi.fn()} canAddGateBefore={() => false} t={t} />)
    const card = view.container.querySelector('[data-responsibility-node="baseline"]')
    expect(card?.closest('[data-responsibility-lane]')?.getAttribute('data-responsibility-lane')).toBe('host')
    expect(view.container.querySelector('[data-responsibility-explanation]')).toBeNull()
    expect(view.getByText('custom_tool')).toBeTruthy()
  })
})
