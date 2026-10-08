/** Whole-run records remain independently renderable at their original log positions. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TrajectoryConversationViewNode } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio/types'

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

/** Trajectory retains the exact event payload through its raw-record renderer. */
export const productionTrajectoryDefinition: ConversationNodeDefinition<ProductionCheckpointData> = {
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
    data: { kind: 'node', node: { kind: 'unknown', seq: context.state.seq, time: context.state.time,
      type: 'production/checkpoint', data: { run: context.state.run } } },
  }),
}
