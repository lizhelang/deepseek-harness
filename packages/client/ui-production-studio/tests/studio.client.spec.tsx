// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import { createStudioDraftStore } from '../src/client/stores.ts'
import { TaskMonitor, ProductionDock } from '../src/client/TaskMonitor.tsx'
import { CasePanel, caseSummary } from '../src/client/CasePanel.tsx'
import { ProductionPolicyView } from '../src/client/RunPolicy.tsx'
import { clampCount, policyMessage, PRESETS } from '../src/client/run-policy.ts'
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
    pause: vi.fn(async () => null), resume: vi.fn(async () => null), reconcile: vi.fn(async () => null),
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
  it('expands the composer monitor without sending anything', () => {
    const b = fixture()
    render(<ProductionDock {...b.props as StudioDockProps} />)
    fireEvent.click(screen.getByRole('button', { name: en['dock.expand'] }))
    expect(screen.getByRole('button', { name: en['dock.collapse'] }).getAttribute('aria-expanded')).toBe('true')
    expect(b.props.send).not.toHaveBeenCalled()
  })
  it('hides the composer dock until the conversation has a task, but still reports a lost connection', () => {
    const b = fixture([])
    const empty = render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(empty.container.querySelector('[data-production-dock]')).toBeNull()
    empty.unmount()
    b.read.set({ snapshot: snapshot(), loading: false, error: 'socket closed' })
    render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(screen.getByText(en['dock.disconnected'])).toBeTruthy()
    expect(b.props.send).not.toHaveBeenCalled()
  })
  it('shows a shared task blocker in an empty session without offering a network reconnect', () => {
    const b = fixture([])
    b.read.set({ snapshot: { ...snapshot(), error: 'Original native invocation needs a receipt' }, loading: false, error: null })
    render(<ProductionDock {...b.props as StudioDockProps} />)
    expect(screen.getByText(en['dock.blocked'])).toBeTruthy()
    expect(screen.queryByText(en['dock.disconnected'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['dock.expand'] }))
    expect(screen.getByText(en['task.blocked'])).toBeTruthy()
    expect(screen.getByText('Original native invocation needs a receipt')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.refresh })).toBeNull()
    expect(document.querySelector('[data-production-blocker]')?.textContent).toMatchInlineSnapshot(
      '"Task cannot continue yetOriginal native invocation needs a receipt"',
    )
    expect(b.props.send).not.toHaveBeenCalled()
  })
  it('reports when reconciliation retains an unknown result', async () => {
    const b = fixture([run('unknown', 'unknown')])
    b.props.reconcile = vi.fn(async () => en['branch.reconcileUnresolved'])
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    await act(async () => { fireEvent.click(screen.getByText(en['branch.reconcile'])) })
    expect(screen.getByRole('alert').textContent).toContain(en['branch.reconcileUnresolved'])
    expect(screen.queryByText(en['branch.resume'])).toBeNull()
    expect(b.props.send).not.toHaveBeenCalled()
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
    const view = caseView({ stage: 'baseline_proposal', phase: 'baseline',
      finishBlockers: [], nextActions: [], rows: [{ candidateId: 'c9c9c9c9c9', kind: 'custom', searchStatus: 'queued' }],
      delivery: { candidateId: 'c9c9c9c9c9', files: [{ kind: 'extraModel', path: '/out/extra.3dm', sha256: 'e'.repeat(64) }] } })
    delete view.bestSearchCandidateId
    delete view.hostCalls
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
    expect(b.props.send).not.toHaveBeenCalled()
  })
  it('explains chat-started work in the empty monitor of a bound conversation', () => {
    const b = fixture([])
    const bound = { ...snapshot(), capabilities: { ...snapshot().capabilities, conversation: { provider: 'aea' } } }
    b.read.set({ snapshot: bound, loading: false, error: null })
    render(<TaskMonitor {...b.props} read={b.read.getSnapshot()} />)
    expect(screen.getByText(en['case.empty'])).toBeTruthy()
    expect(screen.queryByText(en['empty.detail'])).toBeNull()
  })
})

describe('run policy', () => {
  function policyFixture(caseRun = true) {
    const current = run('case-run', 'running')
    current.mode = 'conversation'
    if (caseRun) current.case = caseView({ candidates: { used: 1, limit: 6 } })
    return conversationFixture(current)
  }
  it('composes one line per dimension, omitting sources when only the baseline is delivered', () => {
    const quick = policyMessage(PRESETS.quick, t).split('\n')
    expect(quick[0]).toBe(en['policy.msg.intro'])
    expect(quick.join('\n')).not.toContain('Candidate sources')
    expect(quick.at(-1)).toBe(en['policy.msg.limits'])
    const deep = policyMessage(PRESETS.deep, t)
    expect(deep).toContain('top 3 legal')
    expect(deep).toContain(en['policy.msg.confirm'])
    expect(deep).toContain(en['policy.msg.sources.both'])
  })
  it('clamps counts into the accepted integer range', () => {
    expect(clampCount(Number.NaN, 2, 64)).toBe(2)
    expect(clampCount(100, 2, 64)).toBe(64)
    expect(clampCount(3.6, 2, 64)).toBe(4)
  })
  it('explains loading, unavailable and adapter-less Sessions instead of showing the form', async () => {
    const b = fixture()
    const { container } = render(<ProductionPolicyView {...b.viewProps} />)
    expect(container.querySelector('[data-production-policy]')).toBeNull()
    expect(screen.getByText(en['policy.noAdapter'])).toBeTruthy()
    act(() => { b.read.set({ snapshot: null, loading: true, error: null }) })
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.refresh })).toBeNull()
    act(() => { b.read.set({ snapshot: null, loading: false, error: 'offline' }) })
    expect(screen.getByText('offline')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(b.props.refresh).toHaveBeenCalledOnce()
    act(() => { b.read.set({ snapshot: null, loading: false, error: null }) })
    expect(screen.getByText(en.unavailable)).toBeTruthy()
  })
  it('edits a preset into a custom policy and sends it as one chat request', async () => {
    const b = policyFixture()
    const { container } = render(<ProductionPolicyView {...b.viewProps} />)
    expect(container.querySelector('[data-production-policy="standard"]')).not.toBeNull()
    expect(screen.getByText(t('policy.caseLimit', { limit: 6 }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['policy.mfg.top'] }))
    expect(container.querySelector('[data-production-policy="custom"]')).not.toBeNull()
    expect(screen.getByText(en['policy.custom'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en['policy.manufactureTop']), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: en['policy.sources.host'] }))
    fireEvent.change(screen.getByLabelText(en['policy.candidates']), { target: { value: '5' } })
    fireEvent.click(screen.getByLabelText(en['policy.confirmDelivery']))
    expect(b.drafts.getSnapshot().policy).toEqual({ preset: 'custom', depth: 'limited', candidates: 5, sources: 'host',
      manufacturing: 'top', manufactureTop: 8, confirmDelivery: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['policy.apply'] })) })
    expect(b.props.send).toHaveBeenCalledWith(policyMessage(b.drafts.getSnapshot().policy, t))
    expect(screen.getByRole('status').textContent).toBe(en['policy.applied'])
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['policy.preset.quick']) }))
    expect(b.drafts.getSnapshot().policy).toEqual(PRESETS.quick)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(en['policy.sources'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['policy.depth.exhaustive'] }))
    expect(screen.queryByLabelText(en['policy.candidates'])).toBeNull()
  })
  it('reports a failed send and omits the case limit before a case exists', async () => {
    const b = policyFixture(false)
    let settle: (error: string | null) => void = () => {}
    vi.mocked(b.props.send).mockReturnValueOnce(new Promise((resolve) => { settle = resolve }))
    render(<ProductionPolicyView {...b.viewProps} />)
    expect(screen.queryByText(/Host limit/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['policy.apply'] }))
    expect(screen.getByRole('button', { name: en['action.pending'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => { settle('closed') })
    expect(screen.getByRole('status').textContent).toBe(`${en['action.failed']}: closed`)
  })
})
