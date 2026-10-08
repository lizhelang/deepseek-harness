/** Whole-run records remain independently renderable at their original log positions. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TrajectoryConversationViewNode, TrajectoryRecordNode, TrajectoryRecordPresentation } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Immutable checkpoint data owned by the event, not the current task stream. */
export interface ProductionCheckpointData { seq: number; time: number; run: ProductionRun }

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One committed workflow transition in its original conversation position. */
    'production-checkpoint': ProductionCheckpointData
  }
}

/** Chat projection with one stable identity per committed checkpoint. */
export const productionChatDefinition: ConversationNodeDefinition<ProductionCheckpointData> = {
  kind: 'production-chat-checkpoint',
  target: 'chat',
  match: event => event.type === 'production/checkpoint' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'production/checkpoint') throw new Error('Production checkpoint requires production/checkpoint')
    return { seq: match.event.seq, time: match.event.time, run: match.event.data.run }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context): ChatNode<'production-checkpoint'> | null => context.state === undefined ? null : ({
    key: context.key, kind: 'production-checkpoint', id: context.id, target: 'chat',
    anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible', data: context.state,
  }),
}

/**
 * Registerable Trajectory projection of immutable checkpoints as business rows.
 * @param t - Production namespace translator read when the layout formats a row.
 * @returns a Definition preserving each checkpoint's event data and identity.
 */
export function productionTrajectoryDefinition(t: PropsLocale<'productionStudio'>['t']): ConversationNodeDefinition<ProductionCheckpointData> {
  const format = ({ run }: ProductionCheckpointData): TrajectoryRecordPresentation => {
    const transition = run.history.at(-1)
    const summary = ['production/checkpoint', run.objective, t(`run.${run.phase}`),
      t('checkpoint.version', { version: run.graph.version, revision: run.revision })]
    if (transition !== undefined) summary.push(
      run.graph.nodes.find(node => node.id === transition.nodeId)?.label ?? transition.nodeId,
      t(`phase.${transition.phase}`), transition.message)
    return { label: t('checkpoint.title'), text: summary.filter(Boolean).join(' · '), inputDetail: JSON.stringify({ run }, null, 2) }
  }
  return {
    kind: 'production-trajectory-checkpoint',
    target: 'trajectory',
    match: event => event.type === 'production/checkpoint' ? { id: String(event.seq), role: 'start' } : null,
    start: (_context, match) => {
      if (match.event.type !== 'production/checkpoint') throw new Error('Production checkpoint requires production/checkpoint')
      return { seq: match.event.seq, time: match.event.time, run: match.event.data.run }
    },
    update: context => context.state,
    publication: () => 'immediate',
    buildViewNode: (context): TrajectoryConversationViewNode | null => context.state === undefined ? null : ({
      key: context.key, kind: 'production-trajectory-checkpoint', id: context.id, target: 'trajectory',
      anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'unresolved' },
      data: { kind: 'node', node: { kind: 'record', seq: context.state.seq, time: context.state.time,
        type: 'production/checkpoint', data: context.state, format } satisfies TrajectoryRecordNode<ProductionCheckpointData> },
    }),
  }
}
