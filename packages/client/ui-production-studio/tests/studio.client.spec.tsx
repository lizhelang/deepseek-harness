// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import { createStudioDraftStore } from '../src/client/stores.ts'
import { TaskMonitor, ProductionDock } from '../src/client/TaskMonitor.tsx'
import { ProductionWorkflowView } from '../src/client/WorkflowEditor.tsx'
import type { StudioReadState, StudioSurfaceProps, StudioViewProps, StudioDockProps } from '../src/client/slots.ts'
import { deliveredRun, run, snapshot } from './fixtures.ts'

afterEach(cleanup)
const t: TranslateNS<'productionStudio'> = (key, params = {}) =>
  en[key as keyof typeof en].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })
function hook<T>(source: ObservableSnapshot<T>): SnapshotSelectorHook<T> {
  const subscribe = (listener: () => void) => source.subscribe(listener)
  const getSnapshot = () => source.getSnapshot()
  return selector => selector(useSyncExternalStore(subscribe, getSnapshot, getSnapshot))
}
function fixture(runs = [run('running', 'running')]) {
  const read = createSnapshotStore<StudioReadState>({ snapshot: snapshot(runs), loading: false, error: null })
  const drafts = createStudioDraftStore().create()
  const props: StudioSurfaceProps = {
    t, useProduction: hook(read), useStore: hook(drafts), actions: drafts.actions,
    saveGraph: vi.fn(async () => null), start: vi.fn(async () => null), pause: vi.fn(async () => null),
    resume: vi.fn(async () => null), answer: vi.fn(async () => null), reconcile: vi.fn(async () => null), refresh: vi.fn(),
  }
  return { props, read, drafts }
}

describe('production surfaces', () => {
  it('orders workpieces, collapses completed work and shows no simulated tasks in an empty session', () => {
    const b = fixture([run('complete', 'complete'), run('human', 'human'), run('running', 'running'), run('unknown', 'unknown'), run('wait', 'waiting'), run('pause', 'paused')])
    const { container, rerender } = render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(Array.from(container.querySelectorAll('[data-production-group]')).map(node => node.getAttribute('data-production-group')))
      .toEqual(['critical', 'human', 'waiting', 'running', 'paused', 'complete'])
    expect(container.querySelector('details[data-production-group="complete"]')?.hasAttribute('open')).toBe(false)
    rerender(<TaskMonitor {...b.props} read={{ snapshot: snapshot(), loading: false, error: null }} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(container.querySelectorAll('[data-production-run]')).toHaveLength(0)
  })
  it('preserves unsent human input through live updates and uses branch-specific CAS mutations', async () => {
    const human = run('decision', 'human')
    const b = fixture([human])
    const { rerender } = render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    const input = screen.getByLabelText(en['human.answer'])
    fireEvent.change(input, { target: { value: 'Keep the source model and allow the patch.' } })
    rerender(<TaskMonitor {...b.props} read={{ ...b.read.getSnapshot(), snapshot: snapshot([{ ...human, revision: 3 }]) }} />)
    expect(screen.getByLabelText<HTMLTextAreaElement>(en['human.answer']).value).toBe('Keep the source model and allow the patch.')
    await act(async () => { fireEvent.click(screen.getByText(en['human.accept'])) })
    expect(b.props.answer).toHaveBeenCalledWith({ runId: 'decision', revision: 3, nodeId: 'baseline', answer: 'Keep the source model and allow the patch.', accepted: true })
  })
  it('offers reconciliation rather than resume for an unknown branch', async () => {
    const b = fixture([run('unknown', 'unknown')])
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.queryByText(en['branch.resume'])).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText(en['branch.reconcile'])) })
    expect(b.props.reconcile).toHaveBeenCalledWith({ runId: 'unknown', revision: 2, nodeId: 'baseline' })
  })
  it('keeps blocked diagnostics visible without offering an ineffective resume', () => {
    const blocked = run('blocked', 'blocked'); blocked.phase = 'blocked'
    const b = fixture([blocked])
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.queryByText(en['branch.resume'])).toBeNull()
    expect(screen.queryByText(en['task.resume'])).toBeNull()
    expect(screen.getByText(en['branch.blocked'])).toBeTruthy()
  })
  it('lists verified delivered files directly, separates workshop acceptance and copies the exact saved path', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const b = fixture([deliveredRun()])
      const { container } = render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
      expect(container.querySelector('[data-production-delivery]')).toBeTruthy()
      expect(screen.getByText('manufacturing.3dm')).toBeTruthy()
      expect(screen.getByText(en['delivery.workshop'])).toBeTruthy()
      expect(screen.getByText('Delivery goal: verified')).toBeTruthy()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy file path: /outputs/laser-cut.3dm' })) })
      expect(writeText).toHaveBeenCalledWith('/outputs/laser-cut.3dm')
      expect(screen.getByText(en['delivery.copied'])).toBeTruthy()
    } finally { vi.unstubAllGlobals() }
  })
  it('expands the composer monitor without replacing the draft or starting work', () => {
    const b = fixture()
    render(<ProductionDock {...b.props as StudioDockProps} />)
    fireEvent.click(screen.getByRole('button', { name: en['dock.expand'] }))
    expect(screen.getByRole('button', { name: en['dock.collapse'] }).getAttribute('aria-expanded')).toBe('true')
    expect(b.props.start).not.toHaveBeenCalled()
  })
  it('edits real nodes, preserves start input and requires explicit saved-workflow start', async () => {
    const b = fixture([])
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.change(screen.getByLabelText(en['start.objective']), { target: { value: 'Deliver verified cut files' } })
    fireEvent.change(screen.getByLabelText(en['start.input']), { target: { value: '{"modelPath":"/source.3dm"}' } })
    act(() => { b.read.set({ snapshot: { ...snapshot(), revision: 5 }, loading: false, error: null }) })
    expect(screen.getByLabelText<HTMLTextAreaElement>(en['start.input']).value).toContain('/source.3dm')
    expect(b.props.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: en['start.goalAcknowledged'] }))
    await act(async () => { fireEvent.click(screen.getByText(en['start.action'])) })
    expect(b.props.start).toHaveBeenCalledWith({ graphVersion: 1, objective: 'Deliver verified cut files', goalContractAcknowledged: true,
      input: { modelPath: '/source.3dm', deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Deliver verified cut files' } } })
    fireEvent.click(screen.getByText(en['editor.addAgent']))
    expect(container.querySelector('[data-production-node="agent-1"]')).toBeTruthy()
    expect(b.drafts.getSnapshot().dirty).toBe(true)
    fireEvent.click(screen.getByText(en['editor.delete']))
    expect(container.querySelector('[data-production-node="agent-1"]')).toBeNull()
  })
  it('connects typed ports, rejects incompatible connections and protects delivery gates', () => {
    const b = fixture([])
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.click(screen.getByText(en['editor.addAgent']))
    fireEvent.click(screen.getByRole('button', { name: 'Connect from baseline output success' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Independent review agent input input' }))
    expect(b.drafts.getSnapshot().graph?.edges).toContainEqual({ id: 'edge-1', fromNode: 'baseline', fromPort: 'success', toNode: 'agent-1', toPort: 'input' })
    fireEvent.click(screen.getByRole('button', { name: 'Connect from baseline output success' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect to goal input input' }))
    expect(screen.getByRole('status').textContent).toBe(en['editor.portMismatch'])
    fireEvent.click(container.querySelector('[data-production-node="geometry"] button')!)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.delete'] }).disabled).toBe(true)
  })
  it('retains unfinished gate JSON across node switches and refuses to save the older parsed value', () => {
    const b = fixture([])
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    const select = (id: string) => { fireEvent.click(container.querySelector(`[data-production-node="${id}"] button`)!) }
    fireEvent.click(screen.getByRole('button', { name: en['editor.addGate'] }))
    fireEvent.change(screen.getByLabelText(en['field.expected']), { target: { value: '{' } })
    select('goal'); select('gate-1')
    expect(screen.getByLabelText<HTMLTextAreaElement>(en['field.expected']).value).toBe('{')
    fireEvent.click(screen.getByRole('button', { name: en['editor.save'] }))
    expect(screen.getByRole('status').textContent).toBe(en['editor.invalidFields'])
    expect(b.props.saveGraph).not.toHaveBeenCalled()
  })
  it('binds explicit numeric delivery conditions and resets their acknowledgement when edited', async () => {
    const b = fixture([])
    render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    expect(screen.getByText(en['start.goalScope'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en['start.objective']), { target: { value: 'One piece, no welds' } })
    fireEvent.change(screen.getByLabelText(en['start.maxPieces']), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(en['start.maxWeldActions']), { target: { value: '0' } })
    fireEvent.click(screen.getByText(en['start.action']))
    expect(b.props.start).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(en['start.goalIncomplete'])
    fireEvent.click(screen.getByRole('checkbox', { name: en['start.goalAcknowledged'] }))
    await act(async () => { fireEvent.click(screen.getByText(en['start.action'])) })
    expect(b.props.start).toHaveBeenCalledWith({ graphVersion: 1, objective: 'One piece, no welds', goalContractAcknowledged: true,
      input: { deliveryGoal: { kind: 'verified-drawings', objectiveText: 'One piece, no welds', maxPieces: 1, maxWeldActions: 0 } } })
    fireEvent.change(screen.getByLabelText(en['start.maxPieces']), { target: { value: '2' } })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en['start.goalAcknowledged'] }).checked).toBe(false)
  })
})
