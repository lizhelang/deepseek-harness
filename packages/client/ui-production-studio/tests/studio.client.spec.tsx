// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { createConversationGraph } from '@deepseek-ai/dsh-production-studio/src/domain.ts'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import { createStudioDraftStore } from '../src/client/stores.ts'
import { TaskMonitor, ProductionDock } from '../src/client/TaskMonitor.tsx'
import { CasePanel, caseSummary } from '../src/client/CasePanel.tsx'
import { ProductionWorkflowView } from '../src/client/WorkflowEditor.tsx'
import type { StudioReadState, StudioSurfaceProps, StudioViewProps, StudioDockProps } from '../src/client/slots.ts'
import { caseView, deliveredRun, run, snapshot } from './fixtures.ts'

afterEach(cleanup)
const t: TranslateNS<'productionStudio'> = makeTranslate(en, commonEn)
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
    resume: vi.fn(async () => null), answer: vi.fn(async () => null), reconcile: vi.fn(async () => null),
    send: vi.fn(async (_text: string): Promise<string | null> => null), refresh: vi.fn(),
  }
  // The business-view fixture supplies navigation owners; unused framework seats
  // retain the existing surface-only test double used by the dock fixtures.
  const viewProps: StudioViewProps = { ...props as StudioViewProps,
    inspectCall: undefined, viewRequest: null, openView: vi.fn(), completeViewRequest: vi.fn(),
  }
  return { props, viewProps, read, drafts }
}
function conversationFixture(current: ProductionRun) {
  const b = fixture([current])
  b.read.set({ snapshot: { ...snapshot([current]), graph: current.graph,
    capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } }, loading: false, error: null })
  return b
}
function settledFailureRun(): ProductionRun {
  const failed = run('settled-failure', 'blocked')
  failed.mode = 'conversation'; failed.phase = 'blocked'
  failed.tasks[0]!.settledOperationId = 'settled-call'
  failed.history = [{ nodeId: 'baseline', phase: 'blocked', attempt: 1, message: 'Known failure', time: 2 }]
  return failed
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
    expect(screen.queryByText(en['branch.pause'])).toBeNull()
    expect(screen.queryByText(en['task.pause'])).toBeNull()
    expect(screen.getByText(en['branch.blocked'])).toBeTruthy()
  })
  it.each(['task', 'branch'] as const)('pauses a settled conversation failure through the %s control before offering resume', async (control) => {
    const failed = settledFailureRun(), b = conversationFixture(failed)
    const { rerender } = render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.queryByText(en['task.resume'])).toBeNull()
    expect(screen.queryByText(en['branch.resume'])).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText(en[`${control}.pause`])) })
    const ref = { runId: failed.id, revision: failed.revision, ...(control === 'branch' ? { nodeId: 'baseline' } : {}) }
    expect(b.props.pause).toHaveBeenCalledWith(ref)
    expect(b.props.resume).not.toHaveBeenCalled()
    const paused = structuredClone(failed)
    paused.phase = 'paused'; paused.revision++; paused.tasks[0]!.phase = 'paused'
    rerender(<TaskMonitor {...b.props} read={{ ...b.read.getSnapshot(), snapshot: snapshot([paused]) }} />)
    await act(async () => { fireEvent.click(screen.getByText(en[`${control}.resume`])) })
    expect(b.props.resume).toHaveBeenCalledWith({ ...ref, revision: paused.revision })
  })
  it.each<{ reason: string; change: (failed: ProductionRun) => void }>([
    { reason: 'scheduled work', change: (failed) => { failed.mode = 'scheduled' } },
    { reason: 'exhausted execution budget', change: (failed) => { failed.executions = failed.graph.maxExecutions } },
    { reason: 'no settled receipt', change: (failed) => { delete failed.tasks[0]!.settledOperationId } },
    { reason: 'an in-flight invocation', change: (failed) => { failed.tasks[0]!.operationId = 'pending-call' } },
    { reason: 'another unknown branch', change: (failed) => { failed.tasks.push({ ...failed.tasks[0]!, nodeId: 'geometry', phase: 'unknown' }) } },
    { reason: 'no last transition', change: (failed) => { failed.history = [] } },
    { reason: 'a later non-failure transition', change: (failed) => { failed.history.push({ ...failed.history[0]!, phase: 'complete' }) } },
    { reason: 'a failed verification node', change: (failed) => { failed.graph.nodes[0]!.kind = 'gate' } },
  ])('keeps the settled-failure pause unavailable for $reason', ({ change }) => {
    const failed = settledFailureRun(); change(failed)
    const b = conversationFixture(failed)
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.queryByText(en['task.pause'])).toBeNull()
    expect(screen.queryByText(en['branch.pause'])).toBeNull()
    expect(screen.queryByText(en['task.resume'])).toBeNull()
    expect(screen.queryByText(en['branch.resume'])).toBeNull()
  })
  it('offers settled-failure pause only on the last failed branch', async () => {
    const failed = settledFailureRun()
    failed.graph.nodes.push({ ...failed.graph.nodes[0]!, id: 'repair', label: 'repair' })
    failed.tasks.push({ ...failed.tasks[0]!, nodeId: 'repair' })
    failed.history.push({ ...failed.history[0]!, nodeId: 'repair' })
    const b = conversationFixture(failed)
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    await act(async () => { fireEvent.click(screen.getByText(en['branch.pause'])) })
    expect(b.props.pause).toHaveBeenCalledWith({ runId: failed.id, revision: failed.revision, nodeId: 'repair' })
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
  it('hides the composer dock until the conversation has a task, but still reports a lost connection', () => {
    const b = fixture([])
    const empty = render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(empty.container.querySelector('[data-production-dock]')).toBeNull()
    empty.unmount()
    b.read.set({ snapshot: snapshot(), loading: false, error: 'socket closed' })
    render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(screen.getByText(en['dock.disconnected'])).toBeTruthy()
    expect(b.props.start).not.toHaveBeenCalled()
  })
  it('summarizes the newest AEA case in the dock and shows its panel ahead of node diagnostics', () => {
    const older = run('older', 'running'); older.case = caseView({ caseId: 'aaaaaaaa1111', observedAt: 1 })
    const newer = run('newer', 'running'); newer.case = caseView({ caseId: 'bbbbbbbb2222', observedAt: 2,
      attention: { kind: 'unknown', message: 'Native result unknown' } })
    const b = fixture([older, newer])
    render(<ProductionDock {...b.props as StudioDockProps} />)
    const summary = screen.getByText(/Case bbbbbbbb/)
    expect(summary.textContent).toContain('Improve · candidates 2/8')
    expect(summary.textContent).toContain('best score 39.98')
    expect(summary.textContent).toContain('Native result unknown')
    expect(summary.className).toMatch(/attention/)
    fireEvent.click(screen.getByRole('button', { name: en['dock.expand'] }))
    expect(document.querySelectorAll('[data-case-panel]').length).toBe(1)
    expect(document.querySelector('[data-production-legacy]')).toBeNull()
  })
  it('queues explicit chat requests only for legal case actions and reports the outcome', async () => {
    const first = run('first', 'running'); first.case = caseView()
    const b = fixture([first])
    const view = render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.getAllByRole('button', { name: en['case.do.continueFrom'] })).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: en['case.do.continueFrom'] })[0]!) })
    expect(b.props.send).toHaveBeenCalledWith(en['case.msg.continueFrom'].replace('{id}', 'c1c1c1c1c1'))
    expect(screen.queryAllByRole('button', { name: en['case.do.manufacture'] })).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['case.do.deliverBest'] })) })
    expect(b.props.send).toHaveBeenCalledWith(en['case.msg.deliverBest'].replace('{id}', 'c2c2c2c2c2'))
    expect(screen.getByRole('status').textContent).toBe(en['case.sent'])
    view.unmount()
    const blocked = run('blocked', 'running')
    blocked.case = caseView({ stopReason: 'no_improvement', attention: { kind: 'unknown', message: 'Reconcile first' } })
    const c = fixture([blocked])
    render(<TaskMonitor {...c.props} read={c.read.getSnapshot()} />)
    expect(screen.queryByRole('button', { name: en['case.do.deliverBest'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['case.do.continueFrom'] })).toBeNull()
  })
  it('offers manufacturing for a verified candidate that has none and surfaces a failed send', async () => {
    const first = run('first', 'running')
    first.case = caseView({ stopReason: 'no_improvement', rows: [{ candidateId: 'c3c3c3c3c3', kind: 'improvement', searchStatus: 'verified' }] })
    const b = fixture([first])
    vi.mocked(b.props.send).mockResolvedValueOnce('session closed')
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.queryByRole('button', { name: en['case.do.continueFrom'] })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['case.do.manufacture'] })) })
    expect(b.props.send).toHaveBeenCalledWith(en['case.msg.manufacture'].replace('{id}', 'c3c3c3c3c3'))
    expect(screen.getByRole('status').textContent).toBe(`${en['action.failed']}: session closed`)
  })
  it('keeps a read-only panel without a sender and summarizes a case with no known best score', async () => {
    const view = caseView({ bestSearchCandidateId: undefined, stage: 'baseline_proposal', phase: 'baseline', hostCalls: undefined,
      finishBlockers: [], nextActions: [], rows: [{ candidateId: 'c9c9c9c9c9', kind: 'custom', searchStatus: 'queued' }],
      delivery: { candidateId: 'c9c9c9c9c9', files: [{ kind: 'extraModel', path: '/out/extra.3dm', sha256: 'e'.repeat(64) }] } })
    expect(caseSummary(view, t)).toBe('Case case0001 · Baseline · candidates 2/8')
    render(<CasePanel view={view} t={t} />)
    expect(screen.queryByRole('button', { name: en['case.do.deliverBest'] })).toBeNull()
    expect(screen.queryByText(en['case.table.actions'])).toBeNull()
    expect(screen.getByText('custom')).toBeTruthy(); expect(screen.getByText('queued')).toBeTruthy()
    expect(screen.getByText('extraModel')).toBeTruthy()
    const copy = screen.getByRole('button', { name: en['delivery.copyFile'].replace('{path}', '/out/extra.3dm') })
    await act(async () => { fireEvent.click(copy) })
    expect(copy.textContent).toBe(en['delivery.copy'])
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      await act(async () => { fireEvent.click(copy) })
      expect(writeText).toHaveBeenCalledWith('/out/extra.3dm')
      expect(copy.textContent).toBe(en['delivery.copied'])
    } finally { vi.unstubAllGlobals() }
  })
  it('renders case progress, budgets, blockers, candidates and the verified delivery', () => {
    const view = caseView({ delivery: { candidateId: 'c2c2c2c2c2', files: [{ kind: 'laserCutModel', path: '/out/laser.3dm', sha256: 'f'.repeat(64) }] } })
    const first = run('first', 'complete'); first.case = view
    const b = fixture([first])
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe(en['case.phase.improve'])
    expect(screen.getByText('Candidates 2/8')).toBeTruthy()
    expect(screen.getByText('Host calls 12/48')).toBeTruthy()
    expect(screen.getByText('Best c2c2c2c2 · score 39.98')).toBeTruthy()
    expect(screen.getByText('Try the strip source')).toBeTruthy()
    expect(screen.getByText('Next: generate candidates、finish_custom')).toBeTruthy()
    expect(screen.getByText('Theoretical 2 pieces, 9 bends, 8 welds')).toBeTruthy()
    expect(document.querySelector('[data-case-candidate="c2c2c2c2c2"]')?.getAttribute('data-best')).toBe('true')
    expect(screen.getByText(en['case.mfg.failed'])).toBeTruthy()
    expect(screen.getByText('bend_angle_metadata')).toBeTruthy()
    expect(screen.getByText('/out/laser.3dm')).toBeTruthy()
    expect(screen.getByText(en['case.legacy'])).toBeTruthy()
  })
  it('counts waiting and paused workflows alongside running and complete work', () => {
    const paused = run('paused', 'paused'); paused.phase = 'paused'
    const b = fixture([run('waiting', 'waiting'), paused])
    render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(screen.getByText('0 need attention · 0 running · 1 waiting · 1 paused · 0 complete')).toBeTruthy()
  })
  it('shows connection failure instead of a zero-task summary and retains known tasks', () => {
    const b = fixture()
    b.read.set({ ...b.read.getSnapshot(), error: 'Stream unavailable' })
    render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(screen.getByText(en['dock.disconnected'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dock.expand'] }))
    expect(screen.getByRole('alert').textContent).toContain('Stream unavailable')
    expect(screen.getByText('Workpiece running')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['refresh'] }))
    expect(b.props.refresh).toHaveBeenCalledOnce()
  })
  it('shows current conversation recovery in the dock and summary while retaining the earlier blocked branch', () => {
    const current = run('recovering', 'blocked')
    current.mode = 'conversation'
    current.tasks[0]!.message = 'Earlier baseline failure'
    current.graph.nodes.push({ ...current.graph.nodes[0]!, id: 'repair', label: 'repair' })
    current.tasks.push({ ...current.tasks[0]!, nodeId: 'repair', phase: 'running', message: 'Repair is underway' })
    const b = conversationFixture(current)
    const { container } = render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(screen.getByText(t('dock.summary', { attention: 0, running: 1, waiting: 0, paused: 0, done: 0 }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dock.expand'] }))
    const row = container.querySelector('[data-production-run="recovering"]')!
    expect(row.closest('[data-production-group]')?.getAttribute('data-production-group')).toBe('running')
    expect(row.querySelector('summary')?.textContent).toContain('Repair is underway')
    expect(row.querySelector('summary')?.textContent).not.toContain('Earlier baseline failure')
    expect(screen.getByText('Earlier baseline failure')).toBeTruthy()
    expect(b.props.resume).not.toHaveBeenCalled()
    expect(b.props.start).not.toHaveBeenCalled()
  })
  it('edits real nodes, preserves start input and requires explicit saved-workflow start', async () => {
    const b = fixture([])
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    render(<ProductionWorkflowView {...b.viewProps} />)
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
    const editor = render(<ProductionWorkflowView {...b.viewProps} />)
    expect(screen.queryByText(en['start.action'])).toBeNull()
    expect(screen.queryByLabelText(en['start.objective'])).toBeNull()
    expect(screen.getByText(en['conversation.autoStart'])).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['editor.addAgent'] }).disabled).toBe(true)
    expect(b.props.start).not.toHaveBeenCalled()
    editor.unmount()
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.getByText(en['case.empty'])).toBeTruthy()
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    const { container } = render(<ProductionWorkflowView {...b.viewProps} />)
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
    render(<ProductionWorkflowView {...b.viewProps} />)
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


it('defaults the canonical AEA graph to lanes and inserts a connected future gate for the existing save', async () => {
  const current = run('lanes', 'waiting')
  current.mode = 'conversation'; current.graph = createConversationGraph(24, [])
  current.tasks = []
  const b = conversationFixture(current)
  const view = render(<ProductionWorkflowView {...b.viewProps} />)
  expect(screen.getByText(en['responsibility.aea'])).toBeTruthy()
  expect(view.container.querySelector('[data-production-canvas]')).toBeNull()
  const before = screen.getAllByRole('button', { name: en['responsibility.addGate'] })
  fireEvent.click(before[1]!)
  const draft = b.drafts.getSnapshot().graph!
  const gate = draft.nodes.find(node => node.id === 'gate-1')!
  expect(gate.config.arguments).toEqual(current.graph.nodes.find(node => node.id === 'geometry')!.config.arguments)
  expect(draft.edges.find(edge => edge.fromNode === 'baseline' && edge.fromPort === 'success')?.toNode).toBe(gate.id)
  expect(draft.edges.find(edge => edge.fromNode === gate.id && edge.fromPort === 'success')?.toNode).toBe('geometry')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
  expect(b.props.saveGraph).toHaveBeenCalledWith(current.graph.version, draft)
})

it('moves detached additions to the connection editor and hides old scheduled phases on changed drafts', () => {
  const current = run('scheduled', 'complete')
  current.graph = createConversationGraph(24, []); current.mode = 'scheduled'
  const b = fixture([current])
  b.read.set({ snapshot: { ...snapshot([current]), graph: current.graph }, loading: false, error: null })
  const view = render(<ProductionWorkflowView {...b.viewProps} />)
  expect(view.container.querySelector('[data-responsibility-node="baseline"] [data-phase="complete"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['editor.addGate'] }))
  expect(view.container.querySelector('[data-production-canvas]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['responsibility.view'] }))
  expect(view.container.querySelector('[data-responsibility-node="baseline"] [data-phase="complete"]')).toBeNull()
})
