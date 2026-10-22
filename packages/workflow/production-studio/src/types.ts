/** Session-owned production graphs and durable execution snapshots. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent/types'

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
  /** Stable execution or approval admission; phase changes never unlock its configuration. */
  admitted?: boolean
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
  /** Exact last returned invocation; publication retries never redispatch it. */
  settledOperationId?: string
}
/** Historical transition folded into the run view. */
export interface ProductionHistory { nodeId: string; attempt: number; phase: ProductionNodePhase; message: string; time: number }
/** Bounded usage of one frozen case budget. */
export interface ProductionCaseBudget { used: number; limit: number }
/** One actual candidate as the domain Host last reported it. */
export interface ProductionCaseCandidate {
  candidateId: string
  parentCandidateId?: string
  /** Host attempt kind, such as `baseline` or `improvement`. */
  kind: string
  /** Host-recorded reason for proposing this candidate. */
  hypothesis?: string
  /** Search verification status: `verified`, `failed`, `unknown`, `verifying` or a Host-specific value. */
  searchStatus: string
  /** Lower-is-better search score; absent when the Host has no known score. */
  searchScore?: number
  /** Theoretical counts from the search report, present only when all three are known; never manufacturing actions. */
  searchCounts?: { pieces: number; bends: number; welds: number }
  /** Absent until manufacturing was requested for this candidate. */
  manufacturing?: {
    status: 'passed' | 'failed' | 'unknown' | 'running'
    /** Lower-is-better manufacturing score; absent when not known. */
    score?: number
    /** Measured independent pieces of the manufactured result. */
    pieces?: number
  }
  /** First failed check code or Host error, for one-line display. */
  failure?: string
}
/** A file of the Host-selected delivery, published with its digest. */
export interface ProductionCaseFile { kind: string; path: string; sha256: string }
/**
 * Compact, display-only projection of the latest domain Host receipt for one case.
 * It grants no certificate; delivery checks still read their own evidence.
 */
export interface ProductionCaseView {
  caseId: string
  inputVersion: string
  /** Host workflow revision this view was projected from. */
  revision: number
  /** Coarse stage shown on the progress bar. */
  phase: 'intake' | 'baseline' | 'improve' | 'compare' | 'manufacture' | 'delivered'
  /** Exact Host stage name. */
  stage: string
  candidates: ProductionCaseBudget
  hostCalls?: ProductionCaseBudget
  rows: ProductionCaseCandidate[]
  bestSearchCandidateId?: string
  bestManufacturingCandidateId?: string
  /** Recorded reason the bounded search stopped. */
  stopReason?: string
  /** Host conditions that still prevent ending the search. */
  finishBlockers: string[]
  /** Tool names the Host currently allows next. */
  nextActions: string[]
  /** Present when the user should look at the case. */
  attention?: { kind: 'unknown' | 'blocked' | 'budget'; message: string }
  /** Present once the Host selected an exact manufactured delivery. */
  delivery?: { candidateId: string; files: ProductionCaseFile[] }
  /** Settlement time of the receipt this view was projected from. */
  observedAt: number
}
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
  /** Absent on historical independently scheduled runs. */
  mode?: 'conversation' | 'scheduled'
  /** Trusted adapter and source identity; never selected by model prose. */
  binding?: { provider: string; key: string }
  /** Latest display projection supplied by the trusted conversation adapter. */
  case?: ProductionCaseView
}
/** Single authoritative session projection shared by all Studio views. */
export interface ProductionSnapshot {
  sessionId: SessionId
  revision: number
  graph: ProductionGraph
  runs: ProductionRun[]
  capabilities: { subagent: boolean; tools: string[]; filesystem: boolean; conversation?: { provider: string } }
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
export interface ProductionState {
  format: 1
  revision: number
  graph: ProductionGraph
  runs: ProductionRun[]
  conversationProvider?: string
  pendingCheckpoints?: ProductionRun[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last accepted checkpoint revision per run; retries append no duplicate history. */
    productionCheckpoints: Record<string, number>
    /** Admitted continuation request IDs remain consumed across later task updates. */
    productionContinuationRequests: Record<string, string>
    /** Original native invocation events and duplicate counts used for exact reconciliation. */
    productionNativeInvocations: Record<string, {
      callEvent?: SessionEvent<'tool/call'> | undefined
      resultEvent?: SessionEvent<'tool/result'> | undefined
      callCount: number
      resultCount: number
    }>
  }
}

/** A trusted domain adapter binds direct conversation calls to the graph executor. */
export interface ConversationWorkflowProvider {
  id: string
  toolNames: readonly string[]
  appliesTo(agent: Agent): boolean
  start(call: { agent: Agent; name: string; arguments: JsonValue }): { key: string; objective: string; input: JsonValue } | undefined
  observe(call: { nodeId: string; name: string; arguments: JsonValue; receipt: JsonValue; run: ProductionRun }): {
    key?: string
    input?: JsonValue
    outlet?: ProductionOutlet
    /** A known terminal failure stops routing; unresolved receipts still take precedence. */
    terminal?: true
    message?: string
    /** Display projection of the receipt; replaces the run's previous case view, stamped with the settlement time. */
    caseView?: Omit<ProductionCaseView, 'observedAt'>
  } | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Committed whole-run checkpoint for deterministic Chat and Trajectory replay.
     * @param data - independently renderable immutable execution snapshot.
     */
    'production/checkpoint': { run: ProductionRun }
  }
}

/** DSH-authenticated identity of one original tool invocation. */
export interface NativeInvocationIdentity {
  sessionId: SessionId
  operationId: string
  toolName: string
  /** SHA-256 of the exact UTF-8 tool/call arguments string, without reserialization. */
  argumentSha256: string
}
/** Detached original events and execution ownership supplied only by DSH. */
export interface NativeReconciliationRequest extends NativeInvocationIdentity {
  arguments: JsonValue
  callEvent: SessionEvent<'tool/call'>
  resultEvent?: SessionEvent<'tool/result'>
  runId: ProductionRunId
  nodeId: string
  runRevision: number
  run: ProductionRun
  task: ProductionTask
  lease: { status: 'unknown'; dispatched: boolean; markerSupported: boolean; observedAt: number }
}
/** Host evidence settles execution only; it grants no engineering certificate. */
export interface NativeReconciliationResult extends NativeInvocationIdentity {
  outcome: 'rejected_before_native' | 'completed' | 'unknown'
  receipt: JsonValue
  evidence: JsonValue
}
/** Trusted read-only Host adapter; neither the model nor Remote callers register one. */
export interface NativeReconciliationProvider {
  id: string
  toolNames: readonly string[]
  /** Optional preset/session ownership filter; absent means every Session. */
  appliesTo?(sessionId: SessionId): boolean
  /**
   * Resolve the original invocation without dispatching any tool or native operation.
   * @param request - DSH-owned run, lease and original Session events.
   * @returns matching execution identity and authoritative Host evidence, or unknown.
   */
  reconcile(request: NativeReconciliationRequest): Promise<NativeReconciliationResult>
}

/** One explicit continuation supplied by an authenticated workflow controller. */
export interface ProductionContinuation {
  /** UUID persisted before the one continuation message is admitted. */
  requestId: string
  /** Additional user-authorized instructions, bounded by maxEvidenceBytes with the message. */
  text: string
}
