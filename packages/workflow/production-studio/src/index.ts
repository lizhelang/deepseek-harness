/** Durable, session-owned production scheduling through existing Harness capabilities. */
import { randomUUID, createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId as ToolCallIdentity } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-fs'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { createProductionGraph, decodeProductionState, validateProductionGraph } from './domain.ts'
import { readAeaEvidence } from './aea-evidence.ts'
import type { AnswerProductionRequest, ProductionEvidence, ProductionNode, ProductionOutlet, ProductionRef, ProductionRun, ProductionRunId, ProductionSnapshot, ProductionState, ProductionTask, SaveProductionGraphRequest, StartProductionRunRequest } from './types.ts'

export type * from './types.ts'
export { createProductionGraph, decodeProductionState, validateProductionGraph } from './domain.ts'

declare module '@deepseek-ai/cordis' { interface Context { productionStudio: ProductionStudio } }

/** Deployment limits; per-run budgets are stored in each immutable graph. */
export interface Config {
  /** Default whole-run node execution cap, 80; copied into each new draft and never raised during a run. */
  defaultMaxExecutions?: number
  /** Default independent-task concurrency, three; native AEA calls still serialize under the global lease. */
  defaultMaxConcurrent?: number
  /** Real child provider name, `fork` by default; unavailable providers cannot simulate agent completion. */
  subagentProvider?: string
  /** Maximum retained objective evidence in bytes per node, 262144; exceeding it prevents certification. */
  maxEvidenceBytes?: number
  /** Maximum binary bytes read for each selected file, 4194304; larger files fail readback until deployment config changes. */
  maxFileBytes?: number
  /** Retained transition history entries per run, 400; older entries are removed after the cap. */
  maxHistoryEntries?: number
  /** Retained runs per conversation, 20; reaching the cap blocks new runs while preserving existing history. */
  maxRetainedRuns?: number
}

const nativeLeaseSchema = z.object({ operationId: z.string(), toolName: z.string(), status: z.enum(['running', 'unknown']), observedAt: z.number(), message: z.string(), sessionId: z.string().optional(), markerSupported: z.boolean().default(false), dispatched: z.boolean().default(true) }).strict()
type NativeLease = z.infer<typeof nativeLeaseSchema>
const productionDomain = defineDomain({ name: 'production_studio', version: 1, tables: { sessions: domainTable<SessionId, ProductionState>(z.unknown().transform(decodeProductionState)), native: domainTable<string, NativeLease>(nativeLeaseSchema) } })

interface SessionRuntime {
  agent: Agent
  state: ProductionState
  committed: ProductionState
  workers: Map<string, { controller: AbortController; done: Promise<void> }>
  pausedRun: Set<string>
  scheduling: boolean
  scheduleAgain: boolean
}
interface NodeResult { outlet: ProductionOutlet; data: JsonValue; evidence: ProductionEvidence[]; certificates: ProductionTask['certificates']; message: string }

/** A Host-owned execution classification, never supplied by a model or tool argument. */
class ClassifiedInvocationError extends Error {
  constructor(message: string, readonly outlet: 'failure' | 'unknown', readonly evidence: ProductionEvidence[]) { super(message) }
}

/** Parse only one unambiguous JSON text projection, retaining other values as observed. */
function receiptValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    try { const parsed = json(JSON.parse(value)); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : value }
    catch (error: unknown) { void error; return value }
  }
  if (!Array.isArray(value)) return value
  const texts = value.filter(item => typeof item === 'object' && item !== null && !Array.isArray(item) && item['type'] === 'text')
  if (texts.length !== 1) return value
  const item = texts[0]
  if (typeof item !== 'object' || item === null || Array.isArray(item) || typeof item['text'] !== 'string') return value
  try { return json(JSON.parse(item['text'])) } catch (error: unknown) { void error; return value }
}

/** An AEA success envelope can still report an unresolved native outcome. */
function unresolvedReceipt(data: JsonValue): boolean {
  const manufacturing = field(data, 'workflow.manufacturing')
  const batches = field(data, 'workflow.suggestionBatches')
  return field(data, 'workflow.stage') === 'verification_unknown'
    || Array.isArray(manufacturing) && manufacturing.some(item => field(item, 'status') === 'unknown')
    || Array.isArray(batches) && batches.some(item => field(item, 'status') === 'unknown')
}

/** Resolve a JSON property selector without evaluating code. */
function field(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const name of path.split('.').filter(Boolean)) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = current[name]
  }
  return current
}

/** Only lossless host JSON can enter durable evidence. */
function json(value: unknown): JsonValue { return z.json().parse(value) }

/** These registered AEA operations may enter native execution even when their label sounds observational. */
function nativeTool(name: string): boolean { return /^rhino_/.test(name) || ['create_case', 'begin_workflow', 'get_case_context', 'submit_baseline', 'submit_revision', 'try_suggestion', 'finalize_candidate', 'evaluate_candidate', 'suggest_candidates', 'finish_search', 'resume_search', 'compare_candidates', 'open_review_result', 'propose_candidate'].includes(name) }

/** Safe graph bindings use data selectors, never expressions or shell interpolation. */
function bind(value: JsonValue, input: JsonValue, upstream: JsonValue): JsonValue {
  if (typeof value === 'string' && value.startsWith('$input.')) return field(input, value.slice(7)) ?? null
  if (typeof value === 'string' && value.startsWith('$upstream.')) return field(upstream, value.slice(10)) ?? null
  if (Array.isArray(value)) return value.map(item => bind(item, input, upstream))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, input, upstream)]))
  return value
}

/** Production Studio Host service and its authenticated Remote controller. */
export class ProductionStudio extends TypertRemoteService {
  static inject = ['agents', 'tools', 'subagents', 'fs', 'storageDomain']
  static Config = schema.object({
    defaultMaxExecutions: schema.natural().min(1).default(80), defaultMaxConcurrent: schema.natural().min(1).default(3),
    subagentProvider: schema.string().default('fork'), maxEvidenceBytes: schema.natural().min(1).default(262144),
    maxFileBytes: schema.natural().min(1).default(4194304), maxHistoryEntries: schema.natural().min(1).default(400),
    maxRetainedRuns: schema.natural().min(1).default(20),
  })
  private readonly runtimes = new Map<SessionId, SessionRuntime>()
  private readonly resources = new Set<string>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()
  private readonly limits: Required<Config>
  private closing = false
  private readonly domain: Promise<Domain<typeof productionDomain>>
  private nativeTail: Promise<void> = Promise.resolve()
  private nativeLease: NativeLease | undefined
  private nativeController: AbortController | undefined
  private readonly nativeProviders = new Map<string, number>()
  private readonly notDispatched = new Set<string>()

  /**
 * @param ctx - composed Host capabilities.
 * @param config - deployment defaults and retention limits.
 */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'productionStudio')
    this.domain = ctx.storageDomain.open(productionDomain)
    this.limits = {
      defaultMaxExecutions: config.defaultMaxExecutions ?? 80, defaultMaxConcurrent: config.defaultMaxConcurrent ?? 3,
      subagentProvider: config.subagentProvider ?? 'fork', maxEvidenceBytes: config.maxEvidenceBytes ?? 262144,
      maxFileBytes: config.maxFileBytes ?? 4194304, maxHistoryEntries: config.maxHistoryEntries ?? 400,
      maxRetainedRuns: config.maxRetainedRuns ?? 20,
    }
    createProductionGraph(this.limits.defaultMaxExecutions, this.limits.defaultMaxConcurrent)
    ctx.on('tools/execute', async (exec, next) => {
      if (!nativeTool(exec.name)) return next()
      const previous = this.nativeTail
      let release: (() => void) | undefined
      this.nativeTail = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        if (exec.signal.aborted) return await next()
        if (this.closing) throw new Error('Production Studio is stopping; native work cannot start')
        if (this.nativeLease) throw new Error(`Native execution is quarantined by unresolved operation ${this.nativeLease.operationId}; inspect its existing receipt before any new native action`)
        const lease: NativeLease = { operationId: exec.callId, toolName: exec.name, status: 'running', observedAt: Date.now(), message: 'Native operation is in progress', markerSupported: this.nativeProviders.has(exec.name), dispatched: false, ...(exec.agent ? { sessionId: exec.agent.id } : {}) }
        const domain = await this.domain
        await domain.table('native').put('Rhino', lease)
        this.nativeLease = lease
        const originalSignal = exec.signal
        const controller = new AbortController()
        this.nativeController = controller
        exec.signal = AbortSignal.any([originalSignal, controller.signal])
        try {
          const result = await next()
          // A trusted provider may update the optional lease during the awaited invocation.
          const settledLease = this.nativeLease as NativeLease | undefined
          const knownNoDispatch = settledLease?.markerSupported && !settledLease.dispatched
          const unresolved = !result.isError && unresolvedReceipt(receiptValue(result.value))
          if (result.isError && knownNoDispatch) this.markNotDispatched(exec.callId)
          if (unresolved || result.isError && !knownNoDispatch && result.error.info?.code !== 'ABORTED_BEFORE_DISPATCH') {
            this.nativeLease = { ...(settledLease ?? lease), status: 'unknown', message: 'Native operation returned an uncertain result after dispatch; no subsequent native operation may start until its exact outcome is reconciled' }
            await domain.table('native').put('Rhino', this.nativeLease)
          } else { await domain.table('native').delete('Rhino'); this.nativeLease = undefined }
          return result
        } catch (error: unknown) {
          if (this.nativeLease?.markerSupported && !this.nativeLease.dispatched) { this.markNotDispatched(exec.callId); await domain.table('native').delete('Rhino'); this.nativeLease = undefined }
          else { this.nativeLease = { ...(this.nativeLease ?? lease), status: 'unknown', message: 'Native operation did not settle with a known result; inspect the exact persisted invocation' }; await domain.table('native').put('Rhino', this.nativeLease) }
          throw error
        } finally { exec.signal = originalSignal; if (this.nativeController === controller) this.nativeController = undefined }
      } finally { for (const listeners of this.listeners.values()) for (const listener of listeners) listener(); release?.() }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const runtime = this.runtimes.get(agent.id)
      if (!runtime || runtime.agent !== agent || this.closing) return
      for (const run of runtime.state.runs) {
        runtime.pausedRun.add(run.id)
        for (const task of run.tasks.filter(item => item.phase === 'running')) this.transition(run, task, 'unknown', 'Owning conversation stopped; reconcile the existing operation before resuming')
        this.updateRun(run)
      }
      for (const worker of runtime.workers.values()) worker.controller.abort()
      void this.publish(runtime).catch((error: unknown) => { this.ctx.logger.error('Production Studio interruption persistence failed', error) })
    })
    ctx.effect(() => async () => {
      this.closing = true
      this.nativeController?.abort()
      for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
      this.listeners.clear()
      const workers: Promise<void>[] = []
      for (const runtime of this.runtimes.values()) {
        for (const run of runtime.state.runs) {
          for (const task of run.tasks.filter(item => item.phase === 'running')) this.transition(run, task, 'unknown', 'Host stopped while execution was in progress; reconcile before continuing')
          this.updateRun(run)
        }
        try { await this.publish(runtime) } catch (error: unknown) { this.ctx.logger.error('Production Studio could not persist interruption', error) }
        for (const worker of runtime.workers.values()) { worker.controller.abort(); workers.push(worker.done) }
      }
      await Promise.allSettled(workers)
      await this.nativeTail
      this.runtimes.clear()
      this.resources.clear()
      await (await this.domain).close()
    }, 'productionStudio.quiescence()')
  }

  /** Finish authoritative storage initialization before activating the service. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.domain
    const prior = domain.table('native').get('Rhino')
    if (prior?.markerSupported && !prior.dispatched) await domain.table('native').delete('Rhino')
    else if (prior) { this.nativeLease = { ...prior, status: 'unknown', message: 'Host restarted with an unresolved native invocation; its exact receipt is required before new native work' }; await domain.table('native').put('Rhino', this.nativeLease) }
  }

  /**
   * Register trusted tool providers that mark the actual native dispatch point.
   * The provider owns the returned disposer through its plugin effect.
   * @param toolNames - exact registered tool names implementing the dispatch marker.
   * @returns disposer removing only this provider's declaration.
   */
  registerNativeBoundaryProvider(toolNames: readonly string[]): () => void {
    const names = [...new Set(toolNames)]
    for (const name of names) if (!nativeTool(name)) throw new Error(`Unsupported native dispatch provider for ${name}`)
    for (const name of names) this.nativeProviders.set(name, (this.nativeProviders.get(name) ?? 0) + 1)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const name of names) {
        const remaining = (this.nativeProviders.get(name) ?? 1) - 1
        if (remaining > 0) this.nativeProviders.set(name, remaining)
        else this.nativeProviders.delete(name)
      }
    }
  }

  /**
   * Commit the exact invocation's native dispatch before its provider starts native work.
   * A validation error before this call proves no native work was entered.
   * @param operationId - ToolRuntime call ID of the currently leased invocation.
   * @returns after the native dispatch marker is durable.
   */
  async noteNativeDispatch(operationId: ToolCallIdentity): Promise<void> {
    const lease = this.nativeLease
    if (!lease || lease.operationId !== operationId || lease.status !== 'running' || !lease.markerSupported) throw new Error('No matching trusted native invocation is leased')
    const next = { ...lease, dispatched: true }
    await (await this.domain).table('native').put('Rhino', next)
    this.nativeLease = next
  }

  /**
 * Read state; interrupted persisted executions become unknown and are never replayed.
 * @param sessionId - owning live conversation.
 * @returns current graph and runs.
 */
  @Remote
  async get(sessionId: SessionId): Promise<ProductionSnapshot> { return this.snapshot(await this.runtime(sessionId)) }

  /**
 * Save only the draft; active runs retain their captured graph version.
 * @param sessionId - owning conversation.
 * @param request - expected version and edited draft.
 * @returns committed state.
 */
  @Remote
  async saveGraph(sessionId: SessionId, request: SaveProductionGraphRequest): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    const parsed = z.object({ expectedVersion: z.number().int().nonnegative(), graph: z.unknown() }).strict().parse(request)
    if (runtime.state.graph.version !== parsed.expectedVersion) throw new Error('Production graph changed; reload before saving')
    const graph = validateProductionGraph(parsed.graph)
    for (const protectedNode of runtime.state.graph.nodes.filter(item => item.protected)) {
      const replacement = graph.nodes.find(item => item.id === protectedNode.id)
      if (!replacement || replacement.kind !== protectedNode.kind || replacement.config.certification !== protectedNode.config.certification || replacement.protected !== true || replacement.config.expected !== protectedNode.config.expected || replacement.config.evidencePath !== protectedNode.config.evidencePath || replacement.config.toolName !== protectedNode.config.toolName || replacement.config.evidenceToolName !== protectedNode.config.evidenceToolName || JSON.stringify(replacement.config.arguments) !== JSON.stringify(protectedNode.config.arguments) || JSON.stringify(replacement.config.filePaths) !== JSON.stringify(protectedNode.config.filePaths) || JSON.stringify(replacement.config.fileHashes) !== JSON.stringify(protectedNode.config.fileHashes) || replacement.config.reconcileToolName !== protectedNode.config.reconcileToolName) throw new Error(`Mandatory node ${protectedNode.id} cannot be removed or weakened`)
    }
    graph.version = parsed.expectedVersion + 1
    runtime.state.graph = graph
    await this.publish(runtime)
    return this.snapshot(runtime)
  }

  /**
 * Start new explicitly authorized work with a frozen graph version.
 * @param sessionId - owning conversation.
 * @param request - graph version, objective and source input.
 * @returns initial persisted run.
 */
  @Remote
  async start(sessionId: SessionId, request: StartProductionRunRequest): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    const parsed = z.object({
      graphVersion: z.number().int().positive(), objective: z.string().trim().min(1), input: z.json(),
      goalContractAcknowledged: z.literal(true),
    }).strict().parse(request)
    const goal = z.object({ kind: z.literal('verified-drawings'), objectiveText: z.string().min(1), maxManufacturingScore: z.number().nonnegative().optional(), maxPieces: z.number().int().nonnegative().optional(), maxWeldActions: z.number().int().nonnegative().optional(), maxBendActions: z.number().int().nonnegative().optional() }).strict().parse(field(parsed.input, 'deliveryGoal'))
    if (goal.objectiveText !== parsed.objective) throw new Error('The acknowledged delivery conditions do not match the current objective text')
    if (parsed.graphVersion !== runtime.state.graph.version) throw new Error('Production graph changed; reload before starting')
    if (runtime.state.runs.length >= this.limits.maxRetainedRuns) throw new Error('Retained run limit reached; preserve existing run history before starting more work')
    const graph = validateProductionGraph(runtime.state.graph)
    const now = Date.now()
    const run: ProductionRun = { id: `production-${randomUUID()}` as ProductionRunId, revision: 1, objective: parsed.objective, graph, phase: 'active', executions: 0, input: parsed.input, tasks: graph.nodes.map(node => ({ nodeId: node.id, phase: graph.edges.some(edge => edge.toNode === node.id) ? 'waiting' : 'ready', attempts: 0, message: '', evidence: [], certificates: [], updatedAt: now })), history: [], createdAt: now, updatedAt: now }
    runtime.state.runs.push(run)
    await this.publish(runtime)
    this.schedule(runtime)
    return this.snapshot(runtime)
  }

  /**
 * Pause a branch or whole run; in-flight outcomes remain unknown until reconciled.
 * @param sessionId - owning conversation.
 * @param ref - expected run revision and optional node.
 * @returns committed state.
 */
  @Remote
  async pause(sessionId: SessionId, ref: ProductionRef): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    const run = this.expect(runtime, ref)
    const tasks = ref.nodeId ? [this.task(run, ref.nodeId)] : run.tasks
    if (!ref.nodeId) runtime.pausedRun.add(run.id)
    for (const task of tasks) {
      if (task.phase === 'running') {
        this.transition(run, task, 'unknown', 'Execution interrupted; reconcile the existing operation before continuing')
        runtime.workers.get(`${run.id}/${task.nodeId}`)?.controller.abort()
      } else if (task.phase === 'ready' || task.phase === 'waiting' || task.phase === 'human') this.transition(run, task, 'paused', 'Paused by the user')
    }
    this.updateRun(run)
    if (!ref.nodeId) run.phase = 'paused'
    await this.publish(runtime)
    return this.snapshot(runtime)
  }

  /**
 * Resume only paused work; unknown work refuses replay.
 * @param sessionId - owning conversation.
 * @param ref - expected run revision and optional branch.
 * @returns committed state.
 */
  @Remote
  async resume(sessionId: SessionId, ref: ProductionRef): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    const run = this.expect(runtime, ref)
    const tasks = ref.nodeId ? [this.task(run, ref.nodeId)] : run.tasks
    if (ref.nodeId && tasks[0]?.phase === 'unknown') throw new Error('Unknown operation cannot be replayed; use reconcile')
    if (!ref.nodeId) runtime.pausedRun.delete(run.id)
    for (const task of tasks.filter(item => item.phase === 'paused')) {
      const node = this.node(run, task.nodeId)
      this.transition(run, task, task.breakpoint || node.kind === 'human' ? 'human' : this.hasInputs(node, task, run) ? 'ready' : 'waiting', 'Resumed by the user')
    }
    this.updateRun(run)
    await this.publish(runtime)
    this.schedule(runtime)
    return this.snapshot(runtime)
  }

  /**
 * Supply a human decision without certifying objective evidence.
 * @param sessionId - owning conversation.
 * @param request - exact waiting branch and decision.
 * @returns committed dependent state.
 */
  @Remote
  async answer(sessionId: SessionId, request: AnswerProductionRequest): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    const run = this.expect(runtime, request)
    const task = this.task(run, request.nodeId)
    if (task.phase !== 'human') throw new Error('This production branch is not waiting for a human decision')
    const unknownInput = run.graph.edges.some(edge => edge.toNode === task.nodeId && this.node(run, edge.fromNode).outputs.find(port => port.id === edge.fromPort)?.outlet === 'unknown' && this.task(run, edge.fromNode).phase === 'unknown')
    if (unknownInput) throw new Error('A human answer cannot certify or replay an unknown operation; its exact existing result must be reconciled')
    if (typeof request.answer !== 'string' || !request.answer.trim() || typeof request.accepted !== 'boolean') throw new Error('A human answer and explicit accepted flag are required')
    task.evidence.push({ kind: 'human', nodeId: task.nodeId, attempt: task.attempts, data: { answer: request.answer, accepted: request.accepted }, observedAt: Date.now() })
    if (task.breakpoint === 'before' && this.node(run, task.nodeId).kind !== 'human' && request.accepted) {
      task.breakpointReleased = true
      delete task.breakpoint
      this.transition(run, task, 'ready', request.answer)
    } else {
      const outlet = request.accepted ? task.pendingOutlet ?? 'success' : 'failure'
      delete task.breakpoint
      delete task.pendingOutlet
      this.transition(run, task, outlet === 'success' ? 'complete' : 'blocked', request.answer)
      this.route(run, task, outlet)
      this.activateQueued(run, task)
    }
    this.updateRun(run)
    await this.publish(runtime)
    this.schedule(runtime)
    return this.snapshot(runtime)
  }

  /**
 * Report whether an exact Host reconciliation provider is available for an interrupted invocation.
 * @param sessionId - owning conversation.
 * @param ref - expected unknown branch.
 * @returns observed state; unresolved outcomes stay unknown.
 */
  @Remote
  async reconcile(sessionId: SessionId, ref: ProductionRef): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    const run = this.expect(runtime, ref)
    if (!ref.nodeId) throw new Error('Reconciliation requires one unknown node')
    const task = this.task(run, ref.nodeId)
    if (task.phase !== 'unknown') throw new Error('Only an unknown operation requires reconciliation')
    throw new Error('No Host provider can bind this interrupted operation ID to its exact completed native receipt. The operation remains unknown and will not be replayed; inspect its persisted operation ledger and child trajectory.')
  }

  /**
 * Reconnect-safe projection stream for the same conversation.
 * @param sessionId - owning conversation.
 * @param signal - subscription lifetime.
 * @returns initial and committed subsequent snapshots.
 */
  @Remote({ mode: 'stream' })
  async *follow(sessionId: SessionId, signal: AbortSignal): AsyncIterable<ProductionSnapshot> {
    let pending = true
    let wake: (() => void) | undefined
    const runtime = await this.runtime(sessionId)
    const changed = (): void => { pending = true; wake?.() }
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    this.listeners.set(sessionId, listeners)
    listeners.add(changed)
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted && !this.closing) {
        if (pending) { pending = false; yield this.snapshot(runtime); continue }
        await new Promise<void>((resolve) => { wake = resolve; if (pending || signal.aborted) resolve() })
      }
    } finally { listeners.delete(changed); signal.removeEventListener('abort', abort) }
  }

  /** Recover only this Session's own domain events; a fork inherits no active production authority. */
  private async runtime(sessionId: SessionId): Promise<SessionRuntime> {
    if (this.closing) throw new Error('Production Studio is stopping')
    const agent = this.ctx.agents.get(sessionId)
    if (!agent) throw new Error('Production Studio requires an active conversation')
    const existing = this.runtimes.get(sessionId)
    if (existing && existing.agent === agent) return existing
    const domain = await this.domain
    const afterOpen = this.runtimes.get(sessionId)
    if (afterOpen && afterOpen.agent === agent) return afterOpen
    const saved = domain.table('sessions').get(sessionId)
    const state: ProductionState = saved ? decodeProductionState(saved) : {
      format: 1, revision: 0, graph: createProductionGraph(this.limits.defaultMaxExecutions, this.limits.defaultMaxConcurrent), runs: [],
    }
    const runtime: SessionRuntime = {
      agent, state, committed: structuredClone(state), workers: new Map(), pausedRun: new Set(), scheduling: false, scheduleAgain: false,
    }
    this.runtimes.set(sessionId, runtime)
    let recovered = false
    for (const run of state.runs) {
      let hadInFlight = false
      if (run.phase === 'paused') runtime.pausedRun.add(run.id)
      for (const task of run.tasks.filter(item => item.phase === 'running')) { this.transition(run, task, 'unknown', 'Host restarted with an in-flight operation; reconcile before continuing'); hadInFlight = true; recovered = true }
      if (run.phase === 'active') { run.phase = hadInFlight ? 'unknown' : 'paused'; runtime.pausedRun.add(run.id); recovered = true }
    }
    if (recovered) await this.publish(runtime)
    return runtime
  }

  /** Build detached UI data from committed state and current capabilities. */
  private snapshot(runtime: SessionRuntime): ProductionSnapshot {
    const state = structuredClone(runtime.committed)
    return { sessionId: runtime.agent.id, revision: state.revision, graph: state.graph, runs: state.runs, capabilities: { subagent: this.ctx.subagents.list().includes(this.limits.subagentProvider), tools: [...this.ctx.tools.schemas(runtime.agent).map(tool => tool.name), 'production_aea_evidence'], filesystem: true }, ...(this.nativeLease?.status === 'unknown' ? { error: this.nativeLease.message } : {}) }
  }

  /** Commit before notifying UI subscribers. */
  private async publish(runtime: SessionRuntime): Promise<void> {
    runtime.state.revision++
    const state = decodeProductionState(runtime.state)
    const domain = await this.domain
    try { await domain.table('sessions').put(runtime.agent.id, state) }
    catch (error: unknown) { runtime.state = structuredClone(runtime.committed); throw error }
    runtime.committed = structuredClone(state)
    for (const listener of this.listeners.get(runtime.agent.id) ?? []) { try { listener() } catch (error: unknown) { this.ctx.logger.warn('Production Studio subscriber failed', error) } }
  }

  private expect(runtime: SessionRuntime, ref: ProductionRef): ProductionRun {
    const run = runtime.state.runs.find(item => item.id === ref.runId)
    if (!run) throw new Error('Production run not found')
    if (run.revision !== ref.revision) throw new Error('Production run changed; reload before modifying it')
    if (run.phase === 'complete') throw new Error('Delivered production run is immutable; start a new optimization run')
    return run
  }
  private node(run: ProductionRun, id: string): ProductionNode { const node = run.graph.nodes.find(item => item.id === id); if (!node) throw new Error('Production node not found'); return node }
  private task(run: ProductionRun, id: string): ProductionTask { const task = run.tasks.find(item => item.nodeId === id); if (!task) throw new Error('Production task not found'); return task }
  private transition(run: ProductionRun, task: ProductionTask, phase: ProductionTask['phase'], message: string): void {
    task.phase = phase; task.message = message; task.updatedAt = Date.now(); run.updatedAt = task.updatedAt; run.revision++
    run.history.push({ nodeId: task.nodeId, attempt: task.attempts, phase, message, time: task.updatedAt })
    if (run.history.length > this.limits.maxHistoryEntries) run.history.splice(0, run.history.length - this.limits.maxHistoryEntries)
  }
  private hasInputs(node: ProductionNode, task: ProductionTask, run: ProductionRun): boolean {
    return !run.graph.edges.some(edge => edge.toNode === node.id) || node.inputs.every(port => task.incoming?.[port.id] !== undefined)
  }
  private resourceKeys(node: ProductionNode, agent: Agent): string[] {
    const visible = this.ctx.tools.schemas(agent).map(tool => tool.name)
    const native = node.kind === 'agent' ? (node.config.tools ?? visible).some(nativeTool) : node.config.toolName !== undefined && nativeTool(node.config.toolName)
    return [...new Set([...(native ? ['native:Rhino'] : []), ...(node.resource ? [node.resource] : [])])]
  }

  /** Send only the selected outcome; unrelated and manually paused branches keep their state. */
  private route(run: ProductionRun, task: ProductionTask, outlet: ProductionOutlet): void {
    const node = this.node(run, task.nodeId)
    for (const edge of run.graph.edges.filter(item =>
      item.fromNode === node.id && node.outputs.find(port => port.id === item.fromPort)?.outlet === outlet)) {
      const target = this.task(run, edge.toNode)
      const token = {
        data: task.output ?? { issue: task.message }, evidence: structuredClone(task.evidence), certificates: [...task.certificates],
      }
      if (['running', 'unknown', 'human'].includes(target.phase) || target.incoming?.[edge.toPort] !== undefined) { target.queued ??= []; target.queued.push({ [edge.toPort]: token }); continue }
      target.incoming ??= {}
      target.incoming[edge.toPort] = token
      if (target.phase !== 'paused' && this.hasInputs(this.node(run, target.nodeId), target, run)) this.transition(run, target, 'ready', '')
    }
  }
  private activateQueued(run: ProductionRun, task: ProductionTask): void {
    if (!task.queued?.length || ['running', 'unknown', 'human', 'paused'].includes(task.phase)) return
    task.incoming = task.queued.shift() ?? {}
    const node = this.node(run, task.nodeId)
    while (!this.hasInputs(node, task, run) && task.queued.length) {
      const index = task.queued.findIndex(next => Object.keys(next).some(port => task.incoming?.[port] === undefined))
      if (index < 0) break
      const next = task.queued[index]
      if (!next) break
      const available = Object.fromEntries(Object.entries(next).filter(([port]) => task.incoming?.[port] === undefined))
      const remaining = Object.fromEntries(Object.entries(next).filter(([port]) => task.incoming?.[port] !== undefined))
      task.incoming = { ...task.incoming, ...available }
      if (Object.keys(remaining).length) task.queued[index] = remaining
      else task.queued.splice(index, 1)
    }
    this.transition(run, task, this.hasInputs(node, task, run) ? 'ready' : 'waiting', 'Queued dependent input retained after the previous invocation settled')
  }
  private updateRun(run: ProductionRun): void {
    if (run.tasks.some(task => task.phase === 'unknown')) { run.phase = 'unknown'; return }
    if (run.graph.nodes.filter(node => node.kind === 'delivery').every(node => this.task(run, node.id).phase === 'complete')) { run.phase = 'complete'; return }
    if (run.tasks.some(task => task.phase === 'ready' || task.phase === 'running')) { run.phase = 'active'; return }
    if (run.tasks.some(task => task.phase === 'human')) { run.phase = 'active'; return }
    run.phase = run.tasks.some(task => task.phase === 'paused') ? 'paused' : 'blocked'
  }

  /** Reserve global exclusive resources before launching independent asynchronous branches. */
  private schedule(runtime: SessionRuntime): void {
    if (this.closing || this.ctx.agents.get(runtime.agent.id) !== runtime.agent) return
    if (runtime.scheduling) { runtime.scheduleAgain = true; return }
    runtime.scheduling = true
    queueMicrotask(() => { void (async () => {
      try {
        for (const run of runtime.state.runs) {
          if (run.phase === 'complete' || runtime.pausedRun.has(run.id)) continue
          for (const task of run.tasks.filter(item => item.phase === 'ready')) {
            const node = this.node(run, task.nodeId)
            const resourceKeys = this.resourceKeys(node, runtime.agent)
            if (resourceKeys.includes('native:Rhino') && this.nativeLease?.status === 'unknown') { this.transition(run, task, 'blocked', this.nativeLease.message); this.updateRun(run); await this.publish(runtime); continue }
            if (runtime.workers.size >= run.graph.maxConcurrent) break
            if (resourceKeys.some(key => this.resources.has(key))) continue
            if (run.executions >= run.graph.maxExecutions || task.attempts >= node.maxAttempts) { this.transition(run, task, 'blocked', 'Execution budget exhausted; remaining work is not delivered'); this.updateRun(run); await this.publish(runtime); continue }
            if (node.kind === 'human' || node.config.breakBefore && !task.breakpointReleased) {
              task.breakpoint = 'before'
              const tokens = Object.values(task.incoming ?? {})
              if (node.kind === 'human') { task.certificates = [...new Set(tokens.flatMap(token => token.certificates))]; task.evidence = tokens.flatMap(token => token.evidence); task.output = tokens.length === 1 ? tokens[0]?.data ?? null : run.input }
              this.transition(run, task, 'human', node.config.question ?? 'Confirm this branch before execution'); this.updateRun(run); await this.publish(runtime); continue
            }
            const controller = new AbortController()
            for (const resource of resourceKeys) this.resources.add(resource)
            task.attempts++; run.executions++; task.startedAt = Date.now(); task.operationId = `operation-${randomUUID()}`
            this.transition(run, task, 'running', '')
            await this.publish(runtime)
            if (task.phase !== 'running' || this.closing) { for (const resource of resourceKeys) this.resources.delete(resource); continue }
            const key = `${run.id}/${node.id}`
            const done = this.execute(runtime, run.id, node.id, controller.signal).finally(() => {
              runtime.workers.delete(key)
              for (const resource of resourceKeys) this.resources.delete(resource)
              for (const state of this.runtimes.values()) this.schedule(state)
            })
            runtime.workers.set(key, { controller, done })
          }
        }
      } catch (error: unknown) { this.ctx.logger.error('Production Studio scheduling failed', error) }
      finally { runtime.scheduling = false; if (runtime.scheduleAgain) { runtime.scheduleAgain = false; this.schedule(runtime) } }
    })() })
  }

  /** Settle one owned invocation without publishing late results over a user interruption. */
  private async execute(runtime: SessionRuntime, runId: ProductionRunId, nodeId: string, signal: AbortSignal): Promise<void> {
    let result: NodeResult
    const run = runtime.state.runs.find(item => item.id === runId)
    if (!run) return
    const node = this.node(run, nodeId)
    const task = this.task(run, nodeId)
    try { result = await this.perform(runtime.agent, run, node, task, signal) }
    catch (error: unknown) { result = { outlet: error instanceof ClassifiedInvocationError ? error.outlet : 'unknown', data: { diagnostic: error instanceof Error ? error.message : String(error) }, evidence: error instanceof ClassifiedInvocationError ? error.evidence : [], certificates: [], message: error instanceof ClassifiedInvocationError ? error.message : 'Execution outcome is unknown; reconcile before any retry' } }
    if (this.closing) return
    const currentRun = runtime.state.runs.find(item => item.id === runId)
    if (!currentRun) return
    const current = this.task(currentRun, nodeId)
    if (current.phase !== 'running') return
    current.output = result.data; current.evidence = result.evidence; current.certificates = result.certificates
    delete current.incoming
    delete current.breakpointReleased
    if (node.config.breakAfter && result.outlet !== 'unknown') { current.breakpoint = 'after'; current.pendingOutlet = result.outlet; this.transition(currentRun, current, 'human', 'Execution settled; confirm before releasing dependent branches') }
    else { this.transition(currentRun, current, result.outlet === 'success' ? 'complete' : result.outlet === 'unknown' ? 'unknown' : 'blocked', result.message); this.route(currentRun, current, result.outlet) }
    this.activateQueued(currentRun, current)
    this.updateRun(currentRun)
    await this.publish(runtime)
  }

  /** Run existing guarded tools, real children, and Host-only evidence gates. */
  private async perform(
    agent: Agent, run: ProductionRun, node: ProductionNode, task: ProductionTask, signal: AbortSignal,
  ): Promise<NodeResult> {
    const incoming = Object.values(task.incoming ?? {})
    const upstream: JsonValue = incoming.length === 1 ? incoming[0]?.data ?? null
      : Object.fromEntries(Object.entries(task.incoming ?? {}).map(([key, token]) => [key, token.data]))
    const certificates = [...new Set(incoming.flatMap(token => token.certificates))]
    const evidence = [...incoming.flatMap(token => token.evidence), ...task.evidence.filter(item => item.kind === 'human')]
    const failed = (message: string): NodeResult => ({ outlet: 'failure', data: { issue: message, input: upstream }, evidence, certificates: [], message })
    if (node.kind === 'agent') {
      const observations = new Map<SessionId, SessionEvent[]>()
      const stopWatching = this.ctx.on('session/event', (session, event) => {
        if (session.header.parentSession !== agent.id || event.seq < session.firstLiveSeq) return
        if (event.type !== 'tool/call' && event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return
        const events = observations.get(session.id) ?? []
        events.push(event)
        observations.set(session.id, events)
      })
      const child = await this.ctx.subagents.start(this.limits.subagentProvider, {
        parent: agent, signal, label: node.label, prompt: [{ type: 'text', text: `${node.config.prompt ?? node.label}\nObjective: ${run.objective}\nInput: ${JSON.stringify(run.input)}\nUpstream: ${JSON.stringify(upstream)}\nHuman decisions: ${JSON.stringify(evidence.filter(item => item.kind === 'human').map(item => item.data))}\nUse actual registered tools. A final assistant message is not delivery evidence. Never modify source code, frozen settings, credentials, or replay an unknown native operation.` }],
        ...(node.config.provider && node.config.model
          ? { agentOptions: { provider: node.config.provider, model: node.config.model } } : {}),
        ...(node.config.tools ? { toolFilter: { allow: node.config.tools } } : {}),
      }).catch((error: unknown) => { stopWatching(); throw error })
      try {
        const runtime = this.runtimes.get(agent.id)
        const current = runtime?.state.runs.find(item => item.id === run.id)?.tasks.find(item => item.nodeId === node.id)
        if (current) { current.childSessionId = child.id; if (runtime) await this.publish(runtime) }
        const result = await child.result
        const childSession = child.localAgent?.session
        const childEvents = childSession
          ? (observations.get(child.id) ?? []).filter(event => event.seq >= childSession.firstLiveSeq) : []
        const calls = new Map<string, string>()
        for (const event of childEvents) {
          if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
          if (event.type === 'tool/result' && !event.data.message.isError && calls.has(event.data.message.toolCallId)) {
            for (const block of event.data.message.content) if (block.type === 'text') {
              try { evidence.push({ kind: 'tool', nodeId: node.id, attempt: task.attempts, toolName: calls.get(event.data.message.toolCallId) ?? '', data: json(JSON.parse(block.text)), observedAt: event.time }) }
              catch (error: unknown) { void error /* Human-readable tool text has no objective JSON fields. */ }
            }
          }
          if (event.type === 'tool/ptc-dispatch' && !event.data.isError) {
            for (const block of event.data.content) if (block.type === 'text') {
              try { evidence.push({ kind: 'tool', nodeId: node.id, attempt: task.attempts, toolName: event.data.name, data: json(JSON.parse(block.text)), observedAt: event.time }) }
              catch (error: unknown) { void error /* PTC diagnostic text supplies no objective fields. */ }
            }
          }
        }
        const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (this.nativeLease?.status === 'unknown' && this.nativeLease.sessionId === child.id) return { outlet: 'unknown', data: { diagnostic: this.nativeLease.message }, evidence, certificates: [], message: this.nativeLease.message }
        if (result.stopReason !== 'completed') return result.stopReason === 'aborted' ? { outlet: 'unknown', data: { diagnostic: result.diagnostic ?? result.stopReason }, evidence, certificates: [], message: 'Child interrupted; reconcile any native work before retry' } : failed(result.diagnostic ?? `Child stopped: ${result.stopReason}`)
        this.assertEvidenceSize(evidence)
        return { outlet: 'success', data: { assistant: text, observations: evidence.filter(item => item.kind === 'tool').map(item => item.data) }, evidence, certificates: node.outputs.some(port => port.type === 'candidate') ? [] : certificates, message: '' }
      } finally { stopWatching(); await child.dispose() }
    }
    if (node.config.toolName) {
      if (node.config.toolName !== 'production_aea_evidence' && !this.ctx.tools.get(node.config.toolName, agent)) return failed(`Required tool is unavailable: ${node.config.toolName}`)
      const args = node.config.toolName === 'production_aea_evidence' ? { caseId: field(run.input, 'caseId') ?? null, caseFilePath: field(run.input, 'caseFilePath') ?? null, stage: node.config.certification ?? 'geometry', deliveryGoal: field(run.input, 'deliveryGoal') ?? null } : bind(node.config.arguments ?? run.input, run.input, upstream)
      if (node.config.toolName === 'production_aea_evidence' && typeof args === 'object' && args !== null && !Array.isArray(args)) {
        delete args['receipt']
        for (const key of ['caseId', 'caseFilePath']) if (args[key] === null) {
          for (const receipt of evidence.filter(item => item.kind === 'tool').reverse()) {
            const value = field(receipt.data, key) ?? field(receipt.data, `case.${key}`)
            if (typeof value === 'string') { args[key] = value; break }
          }
        }
        const receipt = evidence.filter(item => item.kind === 'tool' && ['get_case_context', 'begin_workflow', 'compare_candidates', 'finalize_candidate', 'submit_baseline', 'submit_revision', 'try_suggestion'].includes(item.toolName ?? '') && field(item.data, 'workflow') !== undefined).at(-1)
        if (receipt) args['receipt'] = receipt.data
        if (args['deliveryGoal'] === null) delete args['deliveryGoal']
      }
      const observation = await this.invoke(agent, node, task, node.config.toolName, args, signal)
      evidence.push(observation)
    } else if (node.kind === 'program') return failed('Program node has no registered tool binding')
    if (node.config.filePaths?.length) {
      for (const path of node.config.filePaths) {
        const boundPath = bind(path, run.input, upstream)
        const boundHash = bind(node.config.fileHashes?.[node.config.filePaths.indexOf(path)] ?? null, run.input, upstream)
        if (typeof boundPath !== 'string' || typeof boundHash !== 'string' || !/^[a-f0-9]{64}$/i.test(boundHash)) return failed('File readback lacks an exact path and report-bound SHA-256')
        const cwd = agent.session.header.cwd
        const target = await this.ctx.fs.resolve(boundPath, { ...(cwd ? { cwd } : {}), signal })
        const before = await this.ctx.fs.stat(target, signal)
        if (!before || before.type !== 'file' || before.size === undefined || before.size > this.limits.maxFileBytes) return failed(`File readback cannot verify: ${path}`)
        const content = await this.ctx.fs.readBytes(target, signal, this.limits.maxFileBytes)
        const after = await this.ctx.fs.stat(target, signal)
        const sha256 = createHash('sha256').update(content).digest('hex')
        if (!after || before.version !== after.version || content.byteLength === 0 || sha256 !== boundHash.toLowerCase()) return failed(`File changed, is empty, or mismatches its selected report SHA-256: ${path}`)
        evidence.push({ kind: 'file', nodeId: node.id, attempt: task.attempts, data: { path: target.displayPath, sha256, bytes: content.byteLength, version: after.version }, observedAt: Date.now() })
      }
    }
    this.assertEvidenceSize(evidence)
    if (node.kind === 'gate') {
      if (node.config.evidencePath) {
        const observations = evidence.filter(item => item.kind === 'tool' && item.toolName === node.config.evidenceToolName)
        if (!observations.length) return failed('No objective tool receipt is available for this gate')
        const latest = observations.at(-1)
        const value = latest ? field(latest.data, node.config.evidencePath) : undefined
        if (value === undefined) return failed(`Objective receipt lacks ${node.config.evidencePath}; assistant claims cannot substitute`)
        if (JSON.stringify(value) !== JSON.stringify(node.config.expected ?? true)) return failed(`Objective check failed: ${node.config.evidencePath}`)
      } else if (!node.config.filePaths?.length) return failed('Objective gate has no evidence check')
      if (node.config.certification) certificates.push(node.config.certification)
    }
    if (node.kind === 'delivery') {
      for (const required of ['geometry', 'manufacturing', 'files', 'goal'] as const) if (!certificates.includes(required)) return failed(`Delivery lacks objective ${required} evidence`)
      if (!evidence.some(item => item.kind === 'file') && !evidence.some(item => item.kind === 'tool' && item.toolName === 'production_aea_evidence' && field(item.data, 'fileReadbackVerified') === true)) return failed('Delivery requires an actual file readback receipt')
      if (run.tasks.some(item => item.phase === 'unknown')) return failed('Unknown native outcomes prevent delivery')
    }
    return { outlet: 'success', data: evidence.filter(item => item.kind === 'tool').at(-1)?.data ?? upstream, evidence, certificates: [...new Set(certificates)], message: '' }
  }

  /** Check the current scoped schema before entering the shared approval/sandbox ToolRuntime pipeline. */
  private async invoke(
    agent: Agent, node: ProductionNode, task: ProductionTask, name: string, args: JsonValue, signal: AbortSignal,
  ): Promise<ProductionEvidence> {
    if (name === 'production_aea_evidence') {
      const input = z.object({ caseId: z.string().min(1), caseFilePath: z.string().min(1), stage: z.enum(['geometry', 'manufacturing', 'files', 'goal']), deliveryGoal: z.json().optional(), receipt: z.json().optional() }).parse(args)
      return { kind: 'tool', nodeId: node.id, attempt: task.attempts, toolName: name, data: await readAeaEvidence(this.ctx.fs, json(input), signal, this.limits.maxFileBytes), observedAt: Date.now() }
    }
    const tool = this.ctx.tools.get(name, agent)
    if (tool) {
      assertSupportedJsonSchema(tool.parameters)
      const violations = validateJsonSchemaValue(tool.parameters, args, '')
      if (violations.length > 0) {
        const message = `Invalid tool arguments: ${violations.join('; ')}`
        const observation: ProductionEvidence = { kind: 'tool', nodeId: node.id, attempt: task.attempts, toolName: name, data: { error: message, dispatch: 'not-dispatched', stage: 'arguments', violations }, observedAt: Date.now() }
        throw new ClassifiedInvocationError(`Tool ${name} was rejected before dispatch: ${message}`, 'failure', [observation])
      }
    }
    const result = await this.ctx.tools.execute({ callId: ToolCallId(task.operationId ?? `operation-${randomUUID()}`), name, arguments: args, agent, signal })
    const knownNoDispatch = task.operationId !== undefined && this.notDispatched.delete(task.operationId)
    if (result.isError) {
      const known = knownNoDispatch || result.error.info?.code === 'ABORTED_BEFORE_DISPATCH'
      const observation: ProductionEvidence = { kind: 'tool', nodeId: node.id, attempt: task.attempts, toolName: name, data: { error: result.error.message, dispatch: known ? 'not-dispatched' : 'unknown' }, observedAt: Date.now() }
      throw new ClassifiedInvocationError(`Tool ${name} ${known ? 'was rejected before native dispatch' : 'has an unknown execution outcome'}: ${result.error.message}`, known ? 'failure' : 'unknown', [observation])
    }
    const observation: ProductionEvidence = { kind: 'tool', nodeId: node.id, attempt: task.attempts, toolName: name, data: receiptValue(result.value), observedAt: Date.now() }
    if (unresolvedReceipt(observation.data)) throw new ClassifiedInvocationError('Native receipt reports an unresolved operation; reconcile its exact outcome before any retry', 'unknown', [observation])
    return observation
  }
  private assertEvidenceSize(evidence: ProductionEvidence[]): void { if (Buffer.byteLength(JSON.stringify(evidence)) > this.limits.maxEvidenceBytes) throw new Error('Objective evidence exceeds the configured retained byte limit') }
  private markNotDispatched(operationId: string): void {
    this.notDispatched.add(operationId)
    if (this.notDispatched.size > this.limits.maxHistoryEntries) {
      const oldest = this.notDispatched.values().next().value
      if (oldest !== undefined) this.notDispatched.delete(oldest)
    }
  }
}

export default ProductionStudio
