import type {
  AssistantMessageNode, AssistantTiming, ConversationLocation, ConversationNode, ConversationPromptSnapshot,
  ConversationViewNode, MessageImagesOwnerProps, PartialAssistant, RequestPromptChange,
  RequestView, RunningToolCall, SystemPromptNode, ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** Localized presentation of a business record, without model-message semantics. */
export interface TrajectoryRecordPresentation {
  readonly label: string
  readonly text: string
  readonly inputDetail?: string
  readonly outputDetail?: string
  readonly isError?: boolean
}

/**
 * Event-owned business data and its pure, Client-only formatter. A registered
 * Conversation Definition rebuilds both from the log; neither is persisted.
 */
export interface TrajectoryRecordNode<Data = unknown> {
  readonly kind: 'record'
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Data
  /**
   * Format only this node's data using current localized copy.
   * @param data - This node's event-owned data, never a current domain snapshot.
   * @returns a row summary and optional complete inspector payloads.
   */
  format(data: Data): TrajectoryRecordPresentation
}

/** Built-in message nodes and independently registered business records. */
export type TrajectoryEventNode = ConversationNode | TrajectoryRecordNode

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** In-flight assistant output with the loaded Step start and first token timestamps. */
export interface TrajectoryPartialAssistant extends PartialAssistant {
  readonly timing?: Pick<AssistantTiming, 'stepStartTime' | 'firstTokenTime'>
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution =
  | { readonly kind: 'system-prompt'; readonly prompt: SystemPromptNode }
  | {
    readonly kind: 'node'
    readonly node: TrajectoryEventNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: TrajectoryPartialAssistant | null
    readonly request?: Extract<RequestView, { purpose: 'assistant' }>
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: TrajectoryRequestHeaderState
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<RequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
    readonly errorCode?: string
  }

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
  /** Complete loaded prompt text whose request header is outside the window. */
  readonly systemPrompts?: readonly SystemPromptNode[]
  readonly eventNodes: readonly TrajectoryEventNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: TrajectoryPartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

/** Selector hook over the current Conversation binding's Trajectory target. */
export type UseTrajectory = SnapshotSelectorHook<TrajectorySnapshot>

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Trajectory target. */
    useTrajectory: UseTrajectory
  }

  interface SlotMap {
    /**
     * Renderer for one group of durable record images in the Trajectory
     * ledger. The owner supplies image references, an authorized loader, and
     * alignment. A registration replaces the shipped gallery; without one,
     * images are omitted.
     */
    'conversation.trajectory.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
  }
}
