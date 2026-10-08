/** Read-only workflow history renders its own committed data in Chat. */
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Studio.module.css'

/**
 * Render a historical checkpoint without reading or mutating the current run.
 * @param props - Event-owned checkpoint and localized presentation.
 * @returns objective, recorded transition and the node states at that log position.
 */
export function ProductionCheckpointView({ node, t }: Omit<ChatNodeViewProps<'production-checkpoint'>, 't'> & PropsLocale<'productionStudio'>) {
  const { run, seq } = node.data
  const transition = run.history.at(-1)
  return <section className={css.checkpoint} data-production-checkpoint={seq} data-production-run={run.id}>
    <div className={css.toolbar}><strong>{t('checkpoint.title')}</strong>
      <span className={css.phase} data-phase={run.phase}>{t(`run.${run.phase}`)}</span>
      <span className={css.muted}>{t('checkpoint.version', { version: run.graph.version, revision: run.revision })}</span></div>
    <p className={css.message}>{run.objective}</p>
    {transition !== undefined && <p className={css.message}>
      {run.graph.nodes.find(item => item.id === transition.nodeId)?.label ?? transition.nodeId}
      {' · '}{t(`phase.${transition.phase}`)}{transition.message === '' ? '' : ' · ' + transition.message}</p>}
    <details className={css.history}><summary>{t('checkpoint.states')}</summary>
      <ul className={css.branches}>{run.tasks.map(task => <li className={css.branch} key={task.nodeId} data-phase={task.phase}>
        <strong>{run.graph.nodes.find(item => item.id === task.nodeId)?.label ?? task.nodeId}</strong>{' · '}{t(`phase.${task.phase}`)}
        {task.message !== '' && <p className={css.message}>{task.message}</p>}
      </li>)}</ul>
      {run.binding !== undefined && <p className={css.muted}>{t('checkpoint.source', { provider: run.binding.provider, key: run.binding.key })}</p>}
    </details>
  </section>
}
