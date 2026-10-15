/** Three-lane explanation of persisted responsibilities with real task state on real nodes only. */
import type { ProductionGraph, ProductionTask } from '@deepseek-ai/dsh-production-studio/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { responsibilityRows, type ResponsibilityRow } from './responsibility-flow.ts'
import css from './ResponsibilityFlow.module.css'

/** Read-only projection with mutations delegated to the existing editor admission rules. */
export interface ResponsibilityFlowProps extends PropsLocale<'productionStudio'> {
  graph: ProductionGraph
  tasks: readonly ProductionTask[]
  conversation: boolean
  onSelect: (nodeId: string) => void
  onAddGateBefore: (nodeId: string) => void
  canAddGateBefore: (nodeId: string) => boolean
}

/**
 * Show model decisions, Host scheduling, and explanatory AEA operations beside the actual graph nodes.
 * @param props - Graph, observed tasks, editor callbacks, and localized copy.
 * @returns horizontally scrollable responsibility timeline without invented execution nodes.
 */
export function ResponsibilityFlow({
  graph, tasks, conversation, onSelect, onAddGateBefore, canAddGateBefore, t,
}: ResponsibilityFlowProps) {
  const rows = responsibilityRows(graph)
  const phase = new Map(tasks.map(task => [task.nodeId, task.phase]))
  const detail = (row: ResponsibilityRow): string | undefined => {
    if (!row.canonical) return undefined
    if (row.node.kind === 'gate') {
      switch (row.node.config.certification) {
        case 'geometry': return t('responsibility.gateGeometry')
        case 'manufacturing': return t('responsibility.gateManufacturing')
        case 'files': return t('responsibility.gateFiles')
        case 'goal': return t('responsibility.gateGoal')
        case undefined: break
      }
    }
    if (row.node.kind === 'delivery') return t('responsibility.delivery')
    if (row.node.kind === 'agent' && row.node.id === 'baseline') return t(conversation ? 'responsibility.baselineConversation' : 'responsibility.baselineScheduled')
    if (row.node.kind === 'agent' && row.node.id === 'manufacture') return t('responsibility.manufacture')
    if (row.node.kind === 'agent' && row.node.id === 'repair') return t('responsibility.repair')
    return undefined
  }
  const aea = (row: ResponsibilityRow): string | undefined => {
    if (!row.canonical || row.node.kind !== 'agent') return undefined
    if (row.node.id === 'baseline') return t('responsibility.aeaBaseline')
    if (row.node.id === 'manufacture') return t('responsibility.aeaManufacture')
    if (row.node.id === 'repair') return t('responsibility.aeaRepair')
    return undefined
  }
  const observed = (row: ResponsibilityRow) => {
    const state = phase.get(row.node.id)
    return <div className={css.node} data-responsibility-node={row.node.id}>
      <button type="button" className={css.select} onClick={() => { onSelect(row.node.id) }}>{row.node.label}</button>
      <span className={css.phase} data-phase={state}>{state === undefined ? t('responsibility.noObservation') : t(`phase.${state}`)}</span>
      <span className={css.kind}>{t(`node.${row.node.kind}`)}</span>
      {row.node.config.toolName && <code>{row.node.config.toolName}</code>}
      {detail(row) && <p>{detail(row)}</p>}
    </div>
  }
  return <section className={css.root} aria-label={t('responsibility.title')}>
    <p className={css.intro}>{t('responsibility.explanation')}</p>
    <div className={css.scroll}><div className={css.timeline}>
      <div className={css.headers}>
        <div><strong>{t('responsibility.model')}</strong><span>{t('responsibility.modelRole')}</span></div>
        <div><strong>{t('responsibility.host')}</strong><span>{t('responsibility.hostRole')}</span></div>
        <div><strong>{t('responsibility.aea')}</strong><span>{t('responsibility.aeaRole')}</span></div>
      </div>
      {rows.map((row, index) => <div key={row.node.id} className={css.stage} data-recovery={row.recovery}>
        <div className={css.stageLabel}><span>{String(index + 1).padStart(2, '0')}</span><strong>{row.node.label}</strong>
          {row.recovery && <em>{t('responsibility.recovery')}</em>}
        </div>
        <div className={css.cells}>
          <div className={css.cell} data-responsibility-lane="model">{row.lane === 'model' ? <>{observed(row)}<span className={css.direction}>{t('responsibility.modelToHost')}</span></> : <p className={css.muted}>{t('responsibility.modelWait')}</p>}</div>
          <div className={css.cell} data-responsibility-lane="host" data-gate={row.node.kind === 'gate' || row.node.kind === 'human'}>
            {row.lane === 'host' ? observed(row) : <p>{t('responsibility.hostAdmission')}</p>}
            {aea(row) && <span className={css.direction}>{t('responsibility.hostToAea')}</span>}
            {(row.node.kind === 'gate' || row.node.kind === 'human') && <strong className={css.boundary}>{t('responsibility.gateBoundary')}</strong>}
            <Button size="sm" variant="outline" disabled={!canAddGateBefore(row.node.id)} title={t('responsibility.addGateHint')}
              onClick={() => { onAddGateBefore(row.node.id) }}>{t('responsibility.addGate')}</Button>
          </div>
          <div className={css.cell} data-responsibility-lane="aea">
            {aea(row) ? <div data-responsibility-explanation><span className={css.kind}>{t('responsibility.internal')}</span><p>{aea(row)}</p><span className={css.direction}>{t('responsibility.aeaToHost')}</span></div>
              : <p className={css.muted}>{t(row.canonical && row.node.kind === 'gate' ? 'responsibility.readEvidence' : 'responsibility.noAeaMapping')}</p>}
          </div>
        </div>
        <div className={css.handoffs}>{graph.edges.filter(edge => edge.fromNode === row.node.id).map((edge) => {
          const target = graph.nodes.find(node => node.id === edge.toNode)
          const outlet = row.node.outputs.find(port => port.id === edge.fromPort)?.outlet
          return <span key={edge.id} data-outlet={outlet}>{outlet === undefined ? edge.fromPort : t(`outlet.${outlet}`)} → {target?.label ?? edge.toNode}</span>
        })}</div>
      </div>)}
    </div></div>
  </section>
}
