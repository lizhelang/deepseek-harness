// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio/types'
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
function conversationFixture(current: ProductionRun) {
  const b = fixture([current])
  b.read.set({ snapshot: { ...snapshot([current]), graph: current.graph,
    capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } }, loading: false, error: null })
  return b
}
function pointerCanvas() {
  const canvas = screen.getByRole('group', { name: en['editor.canvas'] })
  const capture = vi.fn()
  Object.defineProperties(canvas, {
    setPointerCapture: { value: capture },
    hasPointerCapture: { value: () => false },
  })
  return { canvas, capture }
}
function pointer(target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number, clientY: number): void {
  // jsdom has no PointerEvent; keep real client coordinates on a bubbling DOM event.
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  fireEvent(target, event)
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
  it('starts bound work through chat only, and explains the same execution in the empty monitor', () => {
    const b = fixture([])
    const bound = { ...snapshot(), capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } }
    b.read.set({ snapshot: bound, loading: false, error: null })
    const editor = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    expect(screen.queryByText(en['start.action'])).toBeNull()
    expect(screen.queryByLabelText(en['start.objective'])).toBeNull()
    expect(screen.getByText(en['conversation.autoStart'])).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.addAgent'] }).disabled).toBe(true)
    expect(b.props.start).not.toHaveBeenCalled()
    editor.unmount()
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.getByText(en['conversation.autoStart'])).toBeTruthy()
    expect(screen.queryByText(en['empty.detail'])).toBeNull()
  })
  it('displays authoritative conversation nodes and phases, locks consumed nodes, and edits only future nodes', async () => {
    const current = { ...run('bound', 'running'), mode: 'conversation' as const, binding: { provider: 'aea', key: '/source.3dm' } }
    const authoritative = { ...current.graph, nodes: current.graph.nodes.map(node => node.id === 'goal' ? { ...node, label: 'Remaining goal check' } : node) }
    current.graph = authoritative
    current.tasks.push({ nodeId: 'geometry', phase: 'complete', attempts: 1, message: '', evidence: [], certificates: ['geometry'], updatedAt: 2 },
      { nodeId: 'files', phase: 'unknown', attempts: 1, message: 'Unresolved receipt', evidence: [], certificates: [], updatedAt: 2 })
    const b = fixture([current])
    b.read.set({ snapshot: { ...snapshot([current]), graph: authoritative, capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } }, loading: false, error: null })
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    expect(screen.getByText('Remaining goal check')).toBeTruthy()
    for (const [id, phase] of [['baseline', 'running'], ['geometry', 'complete'], ['files', 'unknown']]) {
      const element = container.querySelector(`[data-production-node="${id}"]`)!
      expect(element.getAttribute('data-phase')).toBe(phase)
      fireEvent.click(element.querySelector('button')!)
      expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(true)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.delete'] }).disabled).toBe(true)
    }
    fireEvent.click(container.querySelector('[data-production-node="goal"] button')!)
    expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(en['field.label']), { target: { value: 'Edited future goal' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    expect(b.props.saveGraph).toHaveBeenCalledOnce()
    const saved = vi.mocked(b.props.saveGraph).mock.calls[0]
    expect(saved?.[0]).toBe(1)
    expect(saved?.[1].nodes.find(node => node.id === 'goal')).toMatchObject({ id: 'goal', label: 'Edited future goal' })
    expect(b.props.start).not.toHaveBeenCalled()
  })
  it('inherits the chat model and cannot raise conversation budgets', () => {
    const current = { ...run('future', 'waiting'), mode: 'conversation' as const }
    current.tasks = current.tasks.map(task => ({ ...task, attempts: 0, admitted: false }))
    const b = fixture([current])
    b.read.set({ snapshot: { ...snapshot([current]), capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } }, loading: false, error: null })
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.click(container.querySelector('[data-production-node="baseline"] button')!)
    expect(screen.getByLabelText<HTMLInputElement>(en['field.provider']).readOnly).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en['field.model']).readOnly).toBe(true)
    fireEvent.change(screen.getByLabelText(en['field.model']), { target: { value: 'ignored-override' } })
    expect(b.drafts.getSnapshot().dirty).toBe(false)
    fireEvent.change(screen.getByLabelText(en['field.attempts']), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText(en['field.executions']), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText(en['field.concurrent']), { target: { value: '10' } })
    expect(b.drafts.getSnapshot().graph?.nodes[0]?.maxAttempts).toBe(3)
    expect(b.drafts.getSnapshot().graph?.maxExecutions).toBe(24)
    expect(b.drafts.getSnapshot().graph?.maxConcurrent).toBe(3)
    fireEvent.change(screen.getByLabelText(en['field.role']), { target: { value: 'Updated future role' } })
    fireEvent.change(screen.getByLabelText(en['field.tools']), { target: { value: 'create_case\ninspect_report' } })
    expect(b.drafts.getSnapshot().graph?.nodes[0]?.config).toMatchObject({ prompt: 'Updated future role', tools: ['create_case', 'inspect_report'] })
    fireEvent.click(screen.getByText(en['editor.addHuman']))
    expect(container.querySelector('[data-production-node="human-1"]')).toBeTruthy()
  })
  it.each([
    { action: 'human approval', kind: 'human', released: 'complete' },
    { action: 'breakBefore release', kind: 'agent', released: 'ready' },
  ] as const)('keeps zero-attempt admission locked after $action while future configuration stays editable', async ({ kind, released }) => {
    const current = { ...run('admitted', 'human'), mode: 'conversation' as const }
    current.graph = { ...current.graph, nodes: current.graph.nodes.map(node => node.id === 'baseline'
      ? { ...node, kind, config: kind === 'human' ? { question: 'Approve the same run?' } : { breakBefore: true, prompt: 'Original role' } } : node) }
    current.tasks = current.tasks.map(task => ({ ...task, admitted: true, attempts: 0 }))
    const b = conversationFixture(current)
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    const { capture } = pointerCanvas()
    const assertLocked = () => {
      fireEvent.click(container.querySelector('[data-production-node="baseline"] button')!)
      expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText(en['field.attempts']), { target: { value: '2' } })
      fireEvent.change(screen.getByLabelText(en[kind === 'human' ? 'field.question' : 'field.role']), { target: { value: 'Forbidden edit' } })
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.delete'] }).disabled).toBe(true)
      const output = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect from baseline output success' })
      expect(output.disabled).toBe(true)
      pointer(output, 'pointerdown', 10, 10)
      expect(capture).not.toHaveBeenCalled()
      fireEvent.click(container.querySelector('[data-production-edge="main-0"] path:last-child')!)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.deleteEdge'] }).disabled).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: en['editor.deleteEdge'] }))
      expect(b.drafts.getSnapshot().dirty).toBe(false)
    }
    assertLocked()
    const updated = { ...current, revision: 3, tasks: current.tasks.map(task => ({ ...task, phase: released, breakpointReleased: released === 'ready' })) }
    act(() => { b.read.set({ ...b.read.getSnapshot(), snapshot: { ...snapshot([updated]), graph: current.graph,
      capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } } }) })
    expect(container.querySelector('[data-production-node="baseline"]')?.getAttribute('data-phase')).toBe(released)
    assertLocked()
    fireEvent.click(container.querySelector('[data-production-node="goal"] button')!)
    expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(en['field.label']), { target: { value: 'Future configuration' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    const saved = vi.mocked(b.props.saveGraph).mock.calls[0]?.[1]
    expect(saved?.nodes.find(node => node.id === 'baseline')).toEqual(current.graph.nodes[0])
    expect(saved?.edges.filter(edge => edge.fromNode === 'baseline')).toEqual(current.graph.edges.filter(edge => edge.fromNode === 'baseline'))
    expect(saved?.nodes.find(node => node.id === 'goal')?.label).toBe('Future configuration')
    expect(b.props.start).not.toHaveBeenCalled()
  })
  it.each([
    { phase: 'ready', attempts: 1, admitted: false },
    { phase: 'human', attempts: 0 },
    { phase: 'paused', attempts: 0 },
    { phase: 'running', attempts: 0 },
    { phase: 'unknown', attempts: 0 },
    { phase: 'complete', attempts: 0 },
  ] as const)('preserves legacy locking for $phase with $attempts attempts', (legacy) => {
    const current = { ...run('legacy', legacy.phase), mode: 'conversation' as const }
    current.tasks = current.tasks.map(task => ({ ...task, ...legacy }))
    const b = conversationFixture(current)
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.click(container.querySelector('[data-production-node="baseline"] button')!)
    expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect from baseline output success' }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en['field.role']), { target: { value: 'Ignored legacy rewrite' } })
    expect(b.drafts.getSnapshot().dirty).toBe(false)
  })
  it.each(['ready', 'complete', 'unknown'] as const)('allows layout-only dragging of an admitted $0 node without rewriting its configuration or routes', async (phase) => {
    const current = { ...run('layout', phase), mode: 'conversation' as const }
    current.tasks = current.tasks.map(task => ({ ...task, admitted: true, attempts: 0 }))
    const b = conversationFixture(current)
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    const { canvas } = pointerCanvas()
    const title = container.querySelector('[data-production-node="baseline"] button')!
    pointer(title, 'pointerdown', 10, 10)
    pointer(canvas, 'pointermove', 30, 20)
    pointer(canvas, 'pointerup', 30, 20)
    const moved = b.drafts.getSnapshot().graph?.nodes.find(node => node.id === 'baseline')
    expect(moved?.x).toBeGreaterThan(current.graph.nodes[0]!.x)
    expect(moved?.y).toBeGreaterThan(current.graph.nodes[0]!.y)
    expect(moved).toEqual({ ...current.graph.nodes[0], x: moved?.x, y: moved?.y })
    expect(b.drafts.getSnapshot().graph?.edges).toEqual(current.graph.edges)
    expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    expect(vi.mocked(b.props.saveGraph).mock.calls[0]?.[1].nodes.find(node => node.id === 'baseline')).toEqual(moved)
  })
  it('checks current admission again when an in-flight wire drag ends, but permits future routes', () => {
    const current = { ...run('future-wire', 'ready'), mode: 'conversation' as const }
    current.tasks = current.tasks.map(task => ({ ...task, attempts: 0, admitted: false }))
    const b = conversationFixture(current)
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.click(screen.getByRole('button', { name: en['editor.addHuman'] }))
    const { canvas } = pointerCanvas()
    const input = screen.getByRole('button', { name: `Connect to ${en['node.newHuman']} input input` })
    const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => input })
    try {
      pointer(screen.getByRole('button', { name: 'Connect from baseline output success' }), 'pointerdown', 10, 10)
      const edges = b.drafts.getSnapshot().graph?.edges
      const admitted = { ...current, revision: 3, tasks: current.tasks.map(task => ({ ...task, admitted: true })) }
      act(() => { b.read.set({ ...b.read.getSnapshot(), snapshot: { ...snapshot([admitted]),
        capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } } }) })
      pointer(canvas, 'pointerup', 50, 50)
      expect(b.drafts.getSnapshot().graph?.edges).toEqual(edges)
      expect(container.querySelectorAll('[data-production-canvas] svg > path')).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: `Connect from ${en['node.newHuman']} output success` }))
      fireEvent.click(screen.getByRole('button', { name: 'Connect to geometry input input' }))
      expect(b.drafts.getSnapshot().graph?.edges).toContainEqual({ id: 'edge-1', fromNode: 'human-1', fromPort: 'success', toNode: 'geometry', toPort: 'input' })
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'elementFromPoint')
      else Object.defineProperty(document, 'elementFromPoint', original)
    }
  })
  it('does not delete a future target of a consumed edge while its configuration and outgoing routes remain editable', () => {
    const current = { ...run('consumed-target', 'ready'), mode: 'conversation' as const }
    current.tasks = current.tasks.map(task => ({ ...task, admitted: true, attempts: 0 }))
    current.graph = { ...current.graph, nodes: current.graph.nodes.map(node => node.id === 'geometry' ? { ...node, protected: false } : node) }
    const b = conversationFixture(current)
    const { container } = render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.click(container.querySelector('[data-production-node="geometry"] button')!)
    expect(container.querySelector<HTMLFieldSetElement>('[data-production-inspector] fieldset')?.disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.delete'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['editor.delete'] }))
    expect(b.drafts.getSnapshot().dirty).toBe(false)
    fireEvent.change(screen.getByLabelText(en['field.evidence']), { target: { value: 'futureGeometryVerified' } })
    expect(b.drafts.getSnapshot().graph?.nodes.find(node => node.id === 'geometry')?.config.evidencePath).toBe('futureGeometryVerified')
    fireEvent.click(container.querySelector('[data-production-edge="main-1"] path:last-child')!)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.deleteEdge'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en['editor.deleteEdge'] }))
    expect(b.drafts.getSnapshot().graph?.edges.some(edge => edge.id === 'main-1')).toBe(false)
    expect(b.drafts.getSnapshot().graph?.edges.find(edge => edge.id === 'main-0')).toEqual(current.graph.edges[0])
  })
  it('keeps unsaved future edits during a remote graph update and reloads only on request', () => {
    const b = fixture([])
    render(<ProductionWorkflowView {...b.props as StudioViewProps} />)
    fireEvent.click(screen.getByText(en['editor.addHuman']))
    const next = snapshot()
    next.graph = { ...next.graph, version: 2, nodes: next.graph.nodes.map(node => ({ ...node, label: `Current ${node.id}` })) }
    act(() => { b.read.set({ snapshot: next, loading: false, error: null }) })
    expect(screen.getByText(en['editor.conflict'])).toBeTruthy()
    expect(screen.getAllByText(en['node.newHuman']).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(en['editor.reload']))
    expect(screen.getAllByText('Current baseline').length).toBeGreaterThan(0)
    expect(b.drafts.getSnapshot().dirty).toBe(false)
  })
})
