/** Session-owned production graphs and durable execution snapshots. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Opaque identity of one immutable graph execution. */
export type ProductionRunId = string & Branded<'ProductionRunId'>
/** Explicit, user-editable artifact port vocabulary. */
export type ProductionPortType = 'input' | 'candidate' | 'geometry' | 'manufacturing' | 'files' | 'delivery' | 'issue' | 'unknown' | 'analysis'
/** Named node terminal route. Unknown never implies permission to replay. */
export type ProductionOutlet = 'success' | 'failure' | 'unknown'
/** User-visible node scheduling phase. */
export type ProductionNodePhase = 'waiting' | 'ready' | 'running' | 'human' | 'paused' | 'blocked' | 'unknown' | 'complete' | 'skipped'
/** One typed, named input or output. */
export interface ProductionPort { id: string; type: ProductionPortType; outlet?: ProductionOutlet }
/** Persisted execution settings and editor placement of one node. */
export interface ProductionNode {
  id: string
  label: string
  kind: 'agent' | 'program' | 'gate' | 'human' | 'delivery'
  x: number
  y: number
  inputs: ProductionPort[]
  outputs: ProductionPort[]
  maxAttempts: number
  resource?: string
  protected?: boolean
  config: {
    prompt?: string
    provider?: string
    model?: string
    toolName?: string
    arguments?: JsonValue
    /** Exact tool JSON field whose value must equal `expected`. */
    evidencePath?: string
    /** Exact registered producer whose receipt this objective gate accepts. */
    evidenceToolName?: string
    expected?: JsonValue
    /** Objective evidence class this gate certifies; assistant text is never evidence. */
    certification?: 'geometry' | 'manufacturing' | 'files' | 'goal'
    /** Human gate question; its answer grants no geometry/manufacturing certificate. */
    question?: string
    /** Paths read through ctx.fs and hashed before file certification or delivery. */
    filePaths?: string[]
    /** SHA-256 bindings paired with filePaths; literals or data selectors. */
    fileHashes?: string[]
    /** Restrict the child to the registered tools named here. */
    tools?: string[]
    breakBefore?: boolean
    breakAfter?: boolean
    /** Read-only operation-status tool, never the interrupted mutation itself. */
    reconcileToolName?: string
  }
}
/** A typed dependency or explicit repair-loop route. */
export interface ProductionEdge { id: string; fromNode: string; fromPort: string; toNode: string; toPort: string }
/** Editable graph draft; each started run stores a detached copy. */
export interface ProductionGraph {
  version: number
  name: string
  nodes: ProductionNode[]
  edges: ProductionEdge[]
  maxExecutions: number
  maxConcurrent: number
}
/** Host-authored observation retained apart from assistant claims. */
export interface ProductionEvidence { kind: 'tool' | 'file' | 'human' | 'agent'; nodeId: string; attempt: number; toolName?: string; data: JsonValue; observedAt: number }
/** One branch's current status and compact execution history. */
export interface ProductionTask {
  nodeId: string
  phase: ProductionNodePhase
  attempts: number
  message: string
  output?: JsonValue
  evidence: ProductionEvidence[]
  certificates: ('geometry' | 'manufacturing' | 'files' | 'goal')[]
  childSessionId?: SessionId
  startedAt?: number
  updatedAt: number
  incoming?: Record<string, { data: JsonValue; evidence: ProductionEvidence[]; certificates: ('geometry' | 'manufacturing' | 'files' | 'goal')[] }>
  queued?: Record<string, { data: JsonValue; evidence: ProductionEvidence[]; certificates: ('geometry' | 'manufacturing' | 'files' | 'goal')[] }>[]
  breakpoint?: 'before' | 'after'
  breakpointReleased?: boolean
  pendingOutlet?: ProductionOutlet
  operationId?: string
}
/** Historical transition folded into the run view. */
export interface ProductionHistory { nodeId: string; attempt: number; phase: ProductionNodePhase; message: string; time: number }
/** Immutable graph version plus mutable persisted execution status. */
export interface ProductionRun {
  id: ProductionRunId
  revision: number
  objective: string
  graph: ProductionGraph
  phase: 'active' | 'paused' | 'blocked' | 'unknown' | 'complete'
  executions: number
  input: JsonValue
  tasks: ProductionTask[]
  history: ProductionHistory[]
  createdAt: number
  updatedAt: number
}
/** Single authoritative session projection shared by all Studio views. */
export interface ProductionSnapshot {
  sessionId: SessionId
  revision: number
  graph: ProductionGraph
  runs: ProductionRun[]
  capabilities: { subagent: boolean; tools: string[]; filesystem: boolean }
  error?: string
}
/** Compare-and-set reference prevents stale UI mutations. */
export interface ProductionRef { runId: ProductionRunId; revision: number; nodeId?: string }
/** Save a draft without rewriting active run graphs. */
export interface SaveProductionGraphRequest { expectedVersion: number; graph: ProductionGraph }
/** User-authorized start of a new run, never automatic replay of old work. */
export interface StartProductionRunRequest { graphVersion: number; objective: string; input: JsonValue; goalContractAcknowledged: boolean }
/** Explicit additional human decision. */
export interface AnswerProductionRequest extends ProductionRef { nodeId: string; answer: string; accepted: boolean }
/** Persisted domain state; capabilities are process-local and recomputed. */
export interface ProductionState { format: 1; revision: number; graph: ProductionGraph; runs: ProductionRun[] }
