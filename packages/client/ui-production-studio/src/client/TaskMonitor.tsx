/** Priority list shared by the full view and compact composer monitor. */
import { useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Input, IconChevronRightOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductionRun, ProductionTask } from '@deepseek-ai/dsh-production-studio/types'
import type { StudioSurfaceProps, StudioDockProps, StudioViewProps, StudioReadState } from './slots.ts'
import { TASK_GROUPS, matchesRun, orderedBranches, prominentBranch, runGroup } from './task-order.ts'
import { verifiedDelivery } from './deliverables.ts'
import css from './Studio.module.css'

/** Presentation props independent of the Conversation slot's owner values. */
export interface TaskMonitorProps extends StudioSurfaceProps {
  read: StudioReadState
  compact?: boolean
}

/** Host pause rechecks native leases before reopening a settled failure. */
function canPauseSettledFailure(run: ProductionRun, nodeId?: string): boolean {
  const last = run.history.at(-1)
  if (run.mode !== 'conversation' || run.phase !== 'blocked' || last?.phase !== 'blocked'
    || run.executions >= run.graph.maxExecutions || run.tasks.some(task => task.operationId || task.phase === 'unknown')) return false
  const task = run.tasks.find(item => item.nodeId === last.nodeId)
  return task !== undefined && (nodeId === undefined || nodeId === task.nodeId) && task.phase === 'blocked'
    && !!task.settledOperationId && run.graph.nodes.some(node => node.id === task.nodeId && node.kind === 'agent')
}

function Branch({ run, task, pending, perform, ...props }: StudioSurfaceProps & {
  run: ProductionRun
  task: ProductionTask
  pending: boolean
  perform: (operation: () => Promise<string | null>) => Promise<void>
}) {
  const { t, useStore, actions, pause, resume, answer, reconcile } = props
  const node = run.graph.nodes.find(candidate => candidate.id === task.nodeId)
  const key = `${run.id}:${task.nodeId}`
  const draft = useStore(state => state.answers[key] ?? '')
  const ref = { runId: run.id, revision: run.revision, nodeId: task.nodeId }
  const waiting = run.graph.edges.filter(edge => edge.toNode === task.nodeId)
    .filter(edge => run.tasks.find(candidate => candidate.nodeId === edge.fromNode)?.phase !== 'complete')
    .map(edge => run.graph.nodes.find(candidate => candidate.id === edge.fromNode)?.label ?? edge.fromNode)
  const history = run.history.filter(entry => entry.nodeId === task.nodeId)
  return <li className={css.branch} data-production-branch={task.nodeId} data-phase={task.phase}>
    <div className={css.branchHeading}>
      <strong>{node?.label ?? task.nodeId}</strong>
      <span className={css.phase} data-phase={task.phase}>{t(`phase.${task.phase}`)}</span>
      <span className={css.muted}>{t('task.attempt', { attempt: task.attempts, maximum: node?.maxAttempts ?? task.attempts })}</span>
      <div className={css.rowActions}>
        {(task.phase === 'running' || task.phase === 'ready' || task.phase === 'waiting' || canPauseSettledFailure(run, task.nodeId)) &&
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { void perform(() => pause(ref)) }}>{t('branch.pause')}</Button>}
        {task.phase === 'paused' &&
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { void perform(() => resume(ref)) }}>{t('branch.resume')}</Button>}
        {task.phase === 'unknown' &&
          <Button size="sm" variant="outline" disabled={pending} onClick={() => { void perform(() => reconcile(ref)) }}>{t('branch.reconcile')}</Button>}
      </div>
    </div>
    {task.message !== '' && <p className={css.message}>{task.message}</p>}
    {task.phase === 'waiting' && waiting.length > 0 && <p className={css.muted}>{t('branch.waiting', { nodes: waiting.join(', ') })}</p>}
    {task.phase === 'unknown' && <p className={css.muted}>{t('branch.unknown')}</p>}
    {task.phase === 'blocked' && <p className={css.muted}>{t(run.mode === 'conversation' ? 'branch.blockedConversation' : 'branch.blocked')}</p>}
    {task.childSessionId !== undefined && <p className={css.muted}>{t('branch.agent', { session: task.childSessionId })}</p>}
    {task.certificates.length > 0 && <p className={css.muted}>{t('branch.certificates', {
      certificates: task.certificates.map(certificate => t(`certificate.${certificate}`)).join(', '),
    })}</p>}
    {task.phase === 'human' && <div className={css.answer}>
      <label className={css.field}>{t('human.answer')}
        <textarea aria-label={t('human.answer')} placeholder={t('human.placeholder')} rows={3} value={draft}
          onChange={(event) => { actions.answer(key, event.target.value) }} />
      </label>
      <div className={css.rowActions}>
        <Button size="sm" variant="primary" disabled={pending || draft.trim() === ''}
          onClick={() => { void perform(() => answer({ ...ref, answer: draft.trim(), accepted: true })) }}>{t('human.accept')}</Button>
        <Button size="sm" variant="outline" disabled={pending || draft.trim() === ''}
          onClick={() => { void perform(() => answer({ ...ref, answer: draft.trim(), accepted: false })) }}>{t('human.reject')}</Button>
      </div>
    </div>}
    {(history.length > 0 || task.evidence.length > 0 || task.output !== undefined) && <details className={css.history}>
      <summary>{t('branch.history')}</summary>
      <ol>{history.map((entry, index) => <li key={`${entry.time}:${index}`}>
        <time>{new Date(entry.time).toLocaleTimeString()}</time>{' '}
        <span>{t('task.attempt', { attempt: entry.attempt, maximum: node?.maxAttempts ?? entry.attempt })}</span>{' · '}
        <span>{t(`phase.${entry.phase}`)}</span>{' · '}{entry.message}
      </li>)}</ol>
      {task.output !== undefined && <details><summary>{t('branch.output')}</summary><pre>{JSON.stringify(task.output, null, 2)}</pre></details>}
      {task.evidence.length > 0 && <details><summary>{t('branch.evidence')}</summary>
        {task.evidence.map((evidence, index) => <pre key={index}>{JSON.stringify(evidence, null, 2)}</pre>)}
      </details>}
    </details>}
  </li>
}

function Delivery({ run, t }: Pick<StudioSurfaceProps, 't'> & { run: ProductionRun }) {
  const delivery = verifiedDelivery(run)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  if (run.phase !== 'complete') return null
  if (delivery === null) return <p className={css.error}>{t('delivery.missing')}</p>
  return <section className={css.delivery} data-production-delivery>
    <h3>{t('delivery.title', { count: delivery.files.length })}</h3>
    <ul className={css.proofs} aria-label={t('delivery.proofs')}>
      {(['geometry', 'manufacturing', 'files', 'goal'] as const).map(certificate =>
        <li key={certificate}>{t('delivery.proofPassed', { proof: t(`certificate.${certificate}`) })}</li>)}
    </ul>
    <p className={css.muted}>{t('delivery.workshop')}</p>
    <ul className={css.deliveryFiles}>{delivery.files.map(file => <li key={file.path}>
      <div className={css.fileHeading}>
        <strong>{file.path.split(/[\\/]/).at(-1)}</strong>
        <span className={css.muted}>{t('delivery.bytes', { bytes: file.bytes.toLocaleString() })}</span>
        <Button size="sm" variant="outline" aria-label={t('delivery.copyFile', { path: file.path })}
          onClick={() => { void writeClipboard(file.path).then((success) => {
            setCopied(success ? file.path : null); setCopyError(!success)
          }) }}>{t(copied === file.path ? 'delivery.copied' : 'delivery.copy')}</Button>
      </div>
      <div className={css.filePath}>{file.path}</div>
      <div className={css.fileDigest}>{t('delivery.sha256', { hash: file.sha256 })}</div>
    </li>)}</ul>
    {copyError && <p className={css.error} role="alert">{t('delivery.copyFailed')}</p>}
  </section>
}

/**
 * Render one top-level row per workpiece, with branches and attempts nested.
 * @param props - Real Host state, localized copy and explicit mutation callbacks.
 * @returns the priority list, empty state or connection failure.
 */
export function TaskMonitor({ read, compact = false, ...props }: TaskMonitorProps) {
  const { t, refresh, pause, resume } = props
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const perform = async (operation: () => Promise<string | null>): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true; setPending(true); setError(null)
    try { setError(await operation()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const snapshot = read.snapshot
  if (snapshot === null && read.loading) return <p className={css.empty}>{t('loading')}</p>
  if (snapshot === null) return <div className={css.empty} role="alert"><p>{read.error ?? t('unavailable')}</p><Button size="sm" onClick={refresh}>{t('refresh')}</Button></div>
  const runs = snapshot.runs.filter(run => matchesRun(run, query))
  return <section className={clsx(css.monitor, compact && css.compact)} data-production-monitor>
    {!compact && <div className={css.toolbar}>
      <h2>{t('view.monitor')}</h2>
      <Input className={clsx(css.search)} aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
    </div>}
    {read.error !== null && <div className={css.error} role="alert">{read.error}<Button size="sm" variant="ghost" onClick={refresh}>{t('refresh')}</Button></div>}
    {error !== null && <p className={css.error} role="alert">{t('action.failed')}{': '}{error}</p>}
    {snapshot.runs.length === 0 && <div className={css.empty}><p>{t('empty')}</p><p>{t(snapshot.capabilities.conversation === undefined ? 'empty.detail' : 'conversation.emptyDetail')}</p></div>}
    {snapshot.runs.length > 0 && runs.length === 0 && <p className={css.empty}>{t('search.empty')}</p>}
    {TASK_GROUPS.map((group) => {
      const members = runs.filter(run => runGroup(run) === group).sort((left, right) => right.updatedAt - left.updatedAt)
      if (members.length === 0) return null
      const body = <div className={css.runList}>{members.map((run) => {
        const complete = run.tasks.filter(task => task.phase === 'complete' || task.phase === 'skipped').length
        const prominent = prominentBranch(run)
        return <details className={css.run} key={run.id} data-production-run={run.id}>
          <summary className={css.runSummary}>
            <IconChevronRightOutlineRegular size={14} />
            <span className={css.runTitle}>{run.objective}
              {prominent !== undefined && prominent.message !== '' && <span className={css.runPreview}>{prominent.message}</span>}
            </span>
            <span className={css.phase} data-phase={run.phase}>{t(`run.${run.phase}`)}</span>
            <span className={css.runMetrics}>{t('task.branches', { complete, total: run.tasks.length, executions: run.executions })}</span>
          </summary>
          <div className={css.runDetails}>
            <div className={css.toolbar}>
              <span className={css.muted}>{t(run.mode === 'conversation' ? 'task.versionLive' : 'task.version', { version: run.graph.version })}</span>
              {(run.phase === 'active' || canPauseSettledFailure(run)) && <Button size="sm" variant="ghost" disabled={pending}
                onClick={() => { void perform(() => pause({ runId: run.id, revision: run.revision })) }}>{t('task.pause')}</Button>}
              {run.phase === 'paused' && <Button size="sm" variant="outline" disabled={pending}
                onClick={() => { void perform(() => resume({ runId: run.id, revision: run.revision })) }}>{t('task.resume')}</Button>}
            </div>
            <Delivery run={run} t={t} />
            <ul className={css.branches}>{orderedBranches(run.tasks).map(task =>
              <Branch key={task.nodeId} {...props} run={run} task={task} pending={pending} perform={perform} />)}</ul>
          </div>
        </details>
      })}</div>
      return group === 'complete'
        ? <details className={css.completed} key={group} data-production-group={group}><summary>{t(`group.${group}`)}{' · '}{members.length}</summary>{body}</details>
        : <section className={css.group} key={group} data-production-group={group}><h3>{t(`group.${group}`)}<span>{members.length}</span></h3>{body}</section>
    })}
  </section>
}

/**
 * Adapt the session-bound monitor tab to its observable Host snapshot.
 * @param props - Slot-derived runtime, draft and mutation props.
 * @returns the complete priority list.
 */
export function ProductionMonitorView(props: StudioViewProps) {
  const read = props.useProduction(value => value)
  return <TaskMonitor {...props} read={read} />
}

/**
 * Keep a compact expandable priority monitor immediately above the composer.
 * @param props - Slot-derived runtime, draft and mutation props.
 * @returns a readable summary with a bounded expanding list.
 */
export function ProductionDock(props: StudioDockProps) {
  const { useProduction, useStore, actions, t } = props
  const read = useProduction(value => value)
  const expanded = useStore(state => state.dockExpanded)
  const runs = read.snapshot?.runs ?? []
  const attention = runs.filter(run => ['critical', 'human'].includes(runGroup(run))).length
  const running = runs.filter(run => runGroup(run) === 'running').length
  const waiting = runs.filter(run => runGroup(run) === 'waiting').length
  const paused = runs.filter(run => runGroup(run) === 'paused').length
  const done = runs.filter(run => run.phase === 'complete').length
  const summary = read.error !== null ? t('dock.disconnected')
    : read.snapshot === null ? t(read.loading ? 'loading' : 'unavailable')
      : runs.length === 0 ? t('dock.empty')
        : t('dock.summary', { attention, running, waiting, paused, done })
  return <section className={css.dock} data-production-dock>
    <button type="button" className={css.dockToggle} aria-expanded={expanded}
      aria-label={t(expanded ? 'dock.collapse' : 'dock.expand')} onClick={() => { actions.expanded(!expanded) }}>
      <IconChevronRightOutlineRegular size={14} />
      <strong>{t('view.monitor')}</strong>
      <span className={clsx(css.dockSummary, (attention > 0 || read.error !== null) && css.attention)}>
        {summary}
      </span>
    </button>
    {expanded && <div className={css.dockList}><TaskMonitor {...props} read={read} compact /></div>}
  </section>
}
