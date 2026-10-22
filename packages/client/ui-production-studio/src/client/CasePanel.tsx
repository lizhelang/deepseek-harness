/** AEA case progress panel projected from the latest Host receipt of a conversation run. */
import { useState } from 'react'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductionCaseCandidate, ProductionCaseView, ProductionRun } from '@deepseek-ai/dsh-production-studio/types'
import { zh, type ProductionStudioKey } from './locales.ts'
import css from './CasePanel.module.css'

type Translate = PropsLocale<'productionStudio'>['t']

const PHASES = ['intake', 'baseline', 'improve', 'compare', 'manufacture', 'delivered'] as const

function known(key: string): key is ProductionStudioKey { return Object.hasOwn(zh, key) }

/**
 * Translate a Host vocabulary value, keeping unrecognized values verbatim.
 * @param t - locale seat.
 * @param prefix - dictionary key prefix.
 * @param value - Host value.
 * @returns localized text or the original value.
 */
function term(t: Translate, prefix: string, value: string): string {
  const key = `${prefix}.${value}`
  return known(key) ? t(key) : value
}

function shortId(id: string): string { return id.slice(0, 8) }

function score(value: number): string { return value.toFixed(2) }

/** Run whose trusted adapter supplied a case projection. */
export type CaseRun = ProductionRun & { case: ProductionCaseView }

/**
 * Narrow a run to one carrying a case projection.
 * @param run - snapshot run.
 * @returns whether the run has a case view.
 */
export function hasCase(run: ProductionRun): run is CaseRun { return run.case !== undefined }

/**
 * Order case runs by their most recent observation, newest first.
 * @param runs - snapshot runs.
 * @returns runs carrying a case view.
 */
export function caseRuns(runs: readonly ProductionRun[]): CaseRun[] {
  return runs.filter(hasCase).sort((left, right) => right.case.observedAt - left.case.observedAt)
}

/**
 * One-line dock summary of a case.
 * @param view - case projection.
 * @param t - locale seat.
 * @returns localized summary text.
 */
export function caseSummary(view: ProductionCaseView, t: Translate): string {
  const parts = [t('case.title', { id: shortId(view.caseId) }),
    t('case.dock', { phase: t(`case.phase.${view.phase}`), used: view.candidates.used, limit: view.candidates.limit })]
  const best = view.rows.find(row => row.candidateId === (view.bestManufacturingCandidateId ?? view.bestSearchCandidateId))
  const bestScore = best?.manufacturing?.score ?? best?.searchScore
  if (bestScore !== undefined) parts.push(t('case.dockBest', { score: score(bestScore) }))
  if (view.attention !== undefined) parts.push(view.attention.message)
  return parts.join(' · ')
}

/** Explicit chat requests the panel may queue for one case. */
interface CaseActions {
  pending: boolean
  request: (key: 'case.msg.deliverBest' | 'case.msg.continueFrom' | 'case.msg.manufacture', candidateId: string) => void
}

function Row({ row, best, t, actions, canContinue, canAct }: {
  row: ProductionCaseCandidate
  best: boolean
  t: Translate
  actions: CaseActions | undefined
  canContinue: boolean
  canAct: boolean
}) {
  const counts = row.searchCounts
  const verified = canAct && row.searchStatus === 'verified'
  return <tr data-case-candidate={row.candidateId} data-best={best || undefined}>
    <td>
      <span className={css.id} title={row.candidateId}>{shortId(row.candidateId)}</span>
      <span className={css.muted}>{term(t, 'case.kind', row.kind)}</span>
      {best && <span className={css.best}>{t('case.markBest')}</span>}
    </td>
    <td>
      <span data-status={row.searchStatus}>{term(t, 'case.search', row.searchStatus)}</span>
      {row.searchScore !== undefined && <span className={css.muted}>{t('case.score', { score: score(row.searchScore) })}</span>}
      {counts !== undefined && <span className={css.muted}>{t('case.counts', counts)}</span>}
    </td>
    <td>
      {row.manufacturing !== undefined && <>
        <span data-status={row.manufacturing.status}>{t(`case.mfg.${row.manufacturing.status}`)}</span>
        {row.manufacturing.score !== undefined && <span className={css.muted}>{t('case.score', { score: score(row.manufacturing.score) })}</span>}
        {row.manufacturing.pieces !== undefined && <span className={css.muted}>{t('case.mfg.pieces', { pieces: row.manufacturing.pieces })}</span>}
      </>}
    </td>
    <td className={css.note}>{row.failure ?? row.hypothesis ?? ''}</td>
    {actions !== undefined && <td className={css.actions}>
      {verified && canContinue && <Button size="sm" variant="ghost" disabled={actions.pending}
        onClick={() => { actions.request('case.msg.continueFrom', row.candidateId) }}>{t('case.do.continueFrom')}</Button>}
      {verified && row.manufacturing === undefined && <Button size="sm" variant="ghost" disabled={actions.pending}
        onClick={() => { actions.request('case.msg.manufacture', row.candidateId) }}>{t('case.do.manufacture')}</Button>}
    </td>}
  </tr>
}

function Delivery({ delivery, t }: { delivery: NonNullable<ProductionCaseView['delivery']>; t: Translate }) {
  const [copied, setCopied] = useState<string | null>(null)
  return <section className={css.delivery} data-case-delivery>
    <h3>{t('case.delivery', { id: shortId(delivery.candidateId) })}</h3>
    <p className={css.muted}>{t('case.workshop')}</p>
    <ul>{delivery.files.map(file => <li key={file.path}>
      <div className={css.fileHeading}>
        <strong>{term(t, 'case.file', file.kind)}</strong>
        <Button size="sm" variant="outline" aria-label={t('delivery.copyFile', { path: file.path })}
          onClick={() => { void writeClipboard(file.path).then((success) => { setCopied(success ? file.path : null) }) }}>
          {t(copied === file.path ? 'delivery.copied' : 'delivery.copy')}</Button>
      </div>
      <div className={css.path}>{file.path}</div>
      <div className={css.digest}>{t('delivery.sha256', { hash: file.sha256 })}</div>
    </li>)}</ul>
  </section>
}

/**
 * Render the case progress, budgets, candidate table and delivered files.
 * Action buttons queue one ordinary chat message; the Host still decides legality.
 * @param props - one case projection, the locale seat and an optional chat sender.
 * @returns the case panel.
 */
export function CasePanel({ view, t, send }: { view: ProductionCaseView; t: Translate; send?: (text: string) => Promise<string | null> }) {
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null)
  const current = PHASES.indexOf(view.phase)
  const bestId = view.bestManufacturingCandidateId ?? view.bestSearchCandidateId
  const best = view.rows.find(row => row.candidateId === bestId)
  const bestScore = best?.manufacturing?.score ?? best?.searchScore
  const canAct = send !== undefined && view.delivery === undefined && view.attention?.kind !== 'unknown'
  const canContinue = view.stopReason === undefined && view.candidates.used < view.candidates.limit
  const actions: CaseActions | undefined = send === undefined ? undefined : {
    pending,
    request: (key, candidateId) => {
      setPending(true); setStatus(null)
      void send(t(key, { id: candidateId })).then((error) => {
        setStatus(error === null ? { error: false, text: t('case.sent') } : { error: true, text: `${t('action.failed')}: ${error}` })
      }).finally(() => { setPending(false) })
    },
  }
  return <section className={css.panel} data-case-panel={view.caseId}>
    <div className={css.heading}>
      <h3 title={view.caseId}>{t('case.title', { id: shortId(view.caseId) })}</h3>
      <span className={css.muted}>{view.stage}</span>
      {actions !== undefined && canAct && best?.searchStatus === 'verified' && <Button size="sm" variant="outline" disabled={pending}
        onClick={() => { actions.request('case.msg.deliverBest', best.candidateId) }}>{t('case.do.deliverBest')}</Button>}
    </div>
    <ol className={css.phases} aria-label={t('case.panel')}>
      {PHASES.map((phase, index) => <li key={phase} data-state={index < current ? 'done' : index === current ? 'current' : 'todo'}
        aria-current={index === current ? 'step' : undefined}>{t(`case.phase.${phase}`)}</li>)}
    </ol>
    {view.attention !== undefined && <p className={css.attention} role="alert" data-kind={view.attention.kind}>{view.attention.message}</p>}
    {status !== null && <p className={status.error ? css.attention : css.muted} role="status">{status.text}</p>}
    <div className={css.budgets}>
      <span>{t('case.candidates', { used: view.candidates.used, limit: view.candidates.limit })}</span>
      {view.hostCalls !== undefined && <span>{t('case.hostCalls', { used: view.hostCalls.used, limit: view.hostCalls.limit })}</span>}
      {bestId !== undefined && <span>{bestScore === undefined
        ? t('case.best', { id: shortId(bestId) })
        : t('case.bestScore', { id: shortId(bestId), score: score(bestScore) })}</span>}
    </div>
    {view.stopReason !== undefined && <p className={css.muted}>{t('case.stopped', { reason: term(t, 'case.stop', view.stopReason) })}</p>}
    {view.finishBlockers.length > 0 && <div className={css.blockers}>
      <p>{t('case.blockers')}</p>
      <ul>{view.finishBlockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
    </div>}
    {view.nextActions.length > 0 && <p className={css.muted}>{t('case.next', { actions: view.nextActions.map(action => term(t, 'case.action', action)).join('、') })}</p>}
    {view.rows.length > 0 && <div className={css.tableWrap}><table className={css.table}>
      <thead><tr>
        <th>{t('case.table.candidate')}</th><th>{t('case.table.search')}</th>
        <th>{t('case.table.manufacturing')}</th><th>{t('case.table.note')}</th>
        {actions !== undefined && <th>{t('case.table.actions')}</th>}
      </tr></thead>
      <tbody>{view.rows.map(row => <Row key={row.candidateId} row={row} best={row.candidateId === bestId} t={t}
        actions={actions} canContinue={canContinue} canAct={canAct} />)}</tbody>
    </table></div>}
    {view.delivery !== undefined && <Delivery delivery={view.delivery} t={t} />}
  </section>
}
