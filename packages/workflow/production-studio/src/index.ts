/** Durable, session-owned production scheduling through existing Harness capabilities. */
import { randomUUID, createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId as ToolCallIdentity, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { createConversationGraph, createProductionGraph, decodeProductionState, validateProductionGraph } from './domain.ts'
import { validateConversationEdit } from './conversation.ts'
import { readAeaEvidence } from './aea-evidence.ts'
import type { AnswerProductionRequest, ConversationWorkflowProvider, NativeReconciliationProvider, NativeReconciliationRequest, NativeReconciliationResult, ProductionContinuation, ProductionEvidence, ProductionNode, ProductionOutlet, ProductionRef, ProductionRun, ProductionRunId, ProductionSnapshot, ProductionState, ProductionTask, SaveProductionGraphRequest, StartProductionRunRequest } from './types.ts'

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

const reconciliationResultSchema = z.object({ sessionId: z.string(), operationId: z.string(), toolName: z.string(), argumentSha256: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(['rejected_before_native', 'completed', 'unknown']), receipt: z.json(), evidence: z.json() }).strict()
const settlementSchema = z.object({
  providerId: z.string(), runId: z.string(), nodeId: z.string(), runRevision: z.number().int(),
  attempts: z.number().int(), executions: z.number().int(), callEventSha256: z.string(),
  resultEventSha256: z.string().optional(), preparedAt: z.number(), result: reconciliationResultSchema,
}).strict()
const nativeLeaseSchema = z.object({ operationId: z.string(), toolName: z.string(), status: z.enum(['running', 'unknown']), observedAt: z.number(), message: z.string(), sessionId: z.string().optional(), markerSupported: z.boolean().default(false), dispatched: z.boolean().default(true), settlement: settlementSchema.optional() }).strict()
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
  mutationTail: Promise<void>
  pendingPublication?: ProductionState
  publicationError?: string
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
  static inject = ['agents', 'tools', 'subagents', 'fs', 'storageDomain', 'sessions', 'sessionProjections']
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
  private readonly reconciliationProviders = new Set<NativeReconciliationProvider>()
  private readonly reconciliationCalls = new Set<Promise<void>>()
  private readonly conversationProviders = new Set<ConversationWorkflowProvider>()
  private readonly conversationCalls = new Set<Promise<void>>()

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
    ctx.sessionProjections.register({ key: 'productionCheckpoints', stateVersion: 1,
      stateSchema: z.record(z.string(), z.number().int().nonnegative()), init: () => ({}),
      apply: (state, event) => event.type === 'production/checkpoint'
        ? { ...state, [event.data.run.id]: Math.max(state[event.data.run.id] ?? 0, event.data.run.revision) } : state })
    ctx.sessionProjections.register({ key: 'productionContinuationRequests', stateVersion: 1,
      stateSchema: z.record(z.string(), z.string()), init: () => ({}), apply: (state, event) => {
        if (event.type !== 'production/checkpoint') return state
        const requests = { ...state }
        for (const task of event.data.run.tasks) for (const evidence of task.evidence) {
          const requestId = field(evidence.data, 'productionContinuation.requestId')
          const messageId = field(evidence.data, 'productionContinuation.messageId')
          if (typeof requestId === 'string' && typeof messageId === 'string') requests[requestId] = messageId
        }
        return requests
      } })
    ctx.sessionProjections.register({ key: 'productionNativeInvocations', stateVersion: 1,
      stateSchema: z.record(z.string(), z.object({ callCount: z.number().int(), resultCount: z.number().int(),
        callEvent: z.custom<SessionEvent<'tool/call'>>().optional(), resultEvent: z.custom<SessionEvent<'tool/result'>>().optional() })),
      init: () => ({}), apply: (state, event) => {
        if (event.type === 'tool/call' && (nativeTool(event.data.name) || state[event.data.callId])) {
          const prior = state[event.data.callId] ?? { callCount: 0, resultCount: 0 }
          return { ...state, [event.data.callId]: { ...prior, callEvent: prior.callEvent ?? event, callCount: prior.callCount + 1 } }
        }
        if (event.type === 'tool/result') {
          const prior = state[event.data.message.toolCallId]
          if (prior) return { ...state, [event.data.message.toolCallId]: { ...prior,
            resultEvent: prior.resultEvent ?? event, resultCount: prior.resultCount + 1 } }
        }
        return state
      } })
    ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembled = await next()
      if (!agent || !this.provider(agent)) return assembled
      await Promise.allSettled([...this.reconciliationCalls])
      const runtime = await this.runtime(agent.id)
      const run = this.conversationRun(runtime)
      if (!run) return assembled
      await this.mutate(runtime, () => this.advanceConversation(runtime, run))
      const task = run.tasks.find(item => this.node(run, item.nodeId).kind === 'agent' && ['ready', 'running'].includes(item.phase))
      const allowed = run.phase === 'active' && !runtime.pausedRun.has(run.id) && task && !task.operationId ? this.node(run, task.nodeId).config.tools ?? [] : []
      const instruction = task ? this.node(run, task.nodeId).config.prompt ?? '' : 'No executable graph node is available. Preserve the run and explain its current blocker.'
      return { ...assembled, tools: assembled.tools.filter(tool => allowed.includes(tool.name)), sections: [...assembled.sections, { name: 'production:execution', text: `Production workflow ${run.id}, graph=${run.graph.version}, phase=${run.phase}:\n${instruction}`, interpolate: false }] }
    })
    // The conversation is the sole executor of agent nodes. This middleware
    // admits and settles that same call; it never invokes its native tool twice.
    ctx.on('tools/execute', async (exec, next) => {
      const provider = exec.agent ? this.provider(exec.agent, exec.name) : undefined
      if (!provider || !exec.agent) return next()
      const agent = exec.agent
      if (this.closing) throw new Error('Production Studio is stopping; conversation work cannot start')
      let release: (() => void) | undefined
      const completion = new Promise<void>((resolve) => { release = resolve })
      this.conversationCalls.add(completion)
      try {
        const runtime = await this.runtime(exec.agent.id)
        const admission = await this.mutate(runtime, async () => {
          let run = this.conversationRun(runtime)
          if (!run) {
            const entry = provider.start({ agent, name: exec.name, arguments: json(exec.arguments) })
            if (!entry) return undefined
            if (runtime.state.runs.some(item => item.phase !== 'complete')) throw new Error('This conversation already owns an unfinished execution; no second executor may start')
            if (runtime.state.runs.length >= this.limits.maxRetainedRuns) throw new Error('Retained run limit reached')
            const now = Date.now()
            const graph = createConversationGraph(this.limits.defaultMaxExecutions, provider.toolNames)
            // Preserve an explicitly edited conversation draft, not the old
            // independent baseline-only scheduler's initial default.
            if (runtime.state.conversationProvider === provider.id) Object.assign(graph, validateProductionGraph(runtime.state.graph))
            run = { id: `production-${randomUUID()}` as ProductionRunId, revision: 1, objective: entry.objective, graph, phase: 'active', executions: 0, input: entry.input, mode: 'conversation', binding: { provider: provider.id, key: entry.key }, tasks: graph.nodes.map(node => ({ nodeId: node.id, phase: graph.edges.some(edge => edge.toNode === node.id) ? 'waiting' : 'ready', attempts: 0, message: '', evidence: [], certificates: [], updatedAt: now })), history: [], createdAt: now, updatedAt: now }
            runtime.state.graph = structuredClone(graph)
            runtime.state.conversationProvider = provider.id
            runtime.state.runs.push(run)
            await this.publish(runtime)
          }
          if (run.binding?.provider !== provider.id) throw new Error('The active graph belongs to another conversation adapter')
          await this.advanceConversation(runtime, run)
          if (run.phase !== 'active' || runtime.pausedRun.has(run.id)) throw new Error(`Conversation workflow is ${run.phase}; no tool is admitted`)
          const task = run.tasks.find(item => this.node(run, item.nodeId).kind === 'agent' && ['ready', 'running'].includes(item.phase))
          if (!task || task.operationId) throw new Error('No free conversation agent node; wait for the existing operation')
          const node = this.node(run, task.nodeId)
          if (!node.config.tools?.includes(exec.name)) throw new Error(`Tool ${exec.name} is not allowed by graph node ${node.id}`)
          if (run.executions >= run.graph.maxExecutions) throw new Error('Conversation graph execution budget exhausted; no delivery claim is allowed')
          if (task.phase === 'ready') {
            if (task.attempts >= node.maxAttempts) throw new Error('Conversation node attempt budget exhausted')
            task.attempts++; task.startedAt = Date.now()
            const incoming = Object.values(task.incoming ?? {})
            task.certificates = [...new Set(incoming.flatMap(item => item.certificates))]
            task.evidence = incoming.flatMap(item => item.evidence)
          }
          task.operationId = exec.callId; run.executions++
          this.transition(run, task, 'running', `正在执行 ${exec.name}`)
          await this.publish(runtime)
          return { runId: run.id, nodeId: node.id }
        })
        if (!admission) return await next()
        let returned = false
        try {
          const result = await next()
          returned = true
          try {
            await this.mutate(runtime, async () => {
              const run = runtime.state.runs.find(item => item.id === admission.runId)
              if (!run) throw new Error('Admitted conversation run disappeared')
              const task = this.task(run, admission.nodeId)
              if (task.operationId !== exec.callId || task.phase === 'unknown') return
              delete task.operationId
              task.settledOperationId = exec.callId
              if (result.isError) {
                const unknown = this.nativeLease?.operationId === exec.callId && this.nativeLease.status === 'unknown'
                this.transition(run, task, unknown ? 'unknown' : 'running', result.error.message)
              } else {
                const receipt = receiptValue(result.value)
                task.output = receipt
                // Full tool history already lives in this exact Session. Retain
                // the latest objective receipt rather than duplicating every turn.
                task.evidence = [...task.evidence.filter(item => item.toolName === 'production_aea_evidence'), { kind: 'tool', nodeId: task.nodeId, attempt: task.attempts, toolName: exec.name, data: receipt, observedAt: Date.now() }]
                let observed: ReturnType<ConversationWorkflowProvider['observe']>
                try {
                  observed = provider.observe({ nodeId: task.nodeId, name: exec.name,
                    arguments: json(exec.arguments), receipt, run: structuredClone(run) })
                } catch (error: unknown) {
                  runtime.pausedRun.add(run.id)
                  this.transition(run, task, 'paused', `Known tool receipt retained; workflow observation failed: ${error instanceof Error ? error.message : String(error)}`)
                  this.updateRun(run); run.phase = 'paused'
                  await this.publish(runtime, true)
                  return
                }
                if (observed?.key && run.binding) run.binding.key = observed.key
                if (observed?.input !== undefined) run.input = observed.input
                const outlet = unresolvedReceipt(receipt) ? 'unknown' : observed?.outlet
                if (outlet) {
                  delete task.incoming
                  if (this.node(run, task.nodeId).config.breakAfter && outlet !== 'unknown') { task.breakpoint = 'after'; task.pendingOutlet = outlet; this.transition(run, task, 'human', observed?.message ?? 'Confirm before the next graph node') }
                  else { this.transition(run, task, outlet === 'success' ? 'complete' : outlet === 'unknown' ? 'unknown' : 'blocked', observed?.message ?? `已返回 ${exec.name}`); this.route(run, task, outlet) }
                  this.activateQueued(run, task)
                } else this.transition(run, task, 'running', observed?.message ?? `已返回 ${exec.name}，等待对话执行下一步`)
              }
              this.updateRun(run)
              if (runtime.pausedRun.has(run.id) && run.phase !== 'unknown' && run.phase !== 'complete') run.phase = 'paused'
              await this.publish(runtime, true)
              await this.advanceConversation(runtime, run)
            }, true)
          } catch (error: unknown) {
          // The ToolRuntime result is already known. Retain its settlement and
          // retry only publication; never turn this storage error into replay.
            runtime.publicationError ??= `Known receipt ${exec.callId} could not be published; only settlement storage may retry`
            this.ctx.logger.error('Production Studio known receipt publication failed', error)
          }
          return result
        } catch (error: unknown) {
          if (returned) throw error
          await this.mutate(runtime, async () => {
            const run = runtime.state.runs.find(item => item.id === admission.runId)
            if (!run) return
            const task = this.task(run, admission.nodeId)
            if (task.operationId === exec.callId) { this.transition(run, task, 'unknown', 'The admitted tool did not return a known result; inspect its exact invocation before continuing'); this.updateRun(run); await this.publish(runtime, true) }
          }, true)
          throw error
        }
      } finally { release?.(); this.conversationCalls.delete(completion) }
    })
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
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result' || this.closing) return
      const lease = this.nativeLease
      if (!lease || lease.status !== 'unknown' || lease.sessionId !== session.id || lease.operationId !== event.data.message.toolCallId) return
      if (!this.reconciliationProvidersFor(session.id, lease.toolName).length) return
      const recovery = (async () => {
        const runtime = await this.runtime(session.id)
        const run = runtime.state.runs.find(item => item.tasks.some(task => task.phase === 'unknown' && (task.operationId ?? task.settledOperationId) === lease.operationId))
        const task = run?.tasks.find(item => item.phase === 'unknown' && (item.operationId ?? item.settledOperationId) === lease.operationId)
        if (run && task) await this.reconcileInvocation(session.id, { runId: run.id, revision: run.revision, nodeId: task.nodeId }, true)
      })().catch((error: unknown) => { this.ctx.logger.warn('Native reconciliation retained quarantine', error) })
      this.reconciliationCalls.add(recovery)
      void recovery.finally(() => this.reconciliationCalls.delete(recovery))
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const runtime = this.runtimes.get(agent.id)
      if (!runtime || runtime.agent !== agent || this.closing) return
      for (const run of runtime.state.runs) runtime.pausedRun.add(run.id)
      for (const worker of runtime.workers.values()) worker.controller.abort()
      void (async () => {
        await Promise.allSettled([...this.conversationCalls])
        await this.mutate(runtime, () => this.stopRuntime(runtime, 'Owning conversation stopped'), true)
      })().catch((error: unknown) => { this.ctx.logger.error('Production Studio interruption persistence failed', error) })
    })
    ctx.effect(() => async () => {
      this.closing = true
      this.nativeController?.abort()
      for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
      this.listeners.clear()
      const workers: Promise<void>[] = []
      for (const runtime of this.runtimes.values()) {
        for (const run of runtime.state.runs) runtime.pausedRun.add(run.id)
        for (const worker of runtime.workers.values()) { worker.controller.abort(); workers.push(worker.done) }
      }
      await Promise.allSettled(workers)
      await Promise.allSettled([...this.reconciliationCalls])
      await this.nativeTail
      await Promise.allSettled([...this.conversationCalls])
      for (const runtime of this.runtimes.values()) {
        try { await this.mutate(runtime, () => this.stopRuntime(runtime, 'Host stopped'), true) }
        catch (error: unknown) { this.ctx.logger.error('Production Studio could not persist interruption', error) }
      }
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
   * Register a trusted profile adapter; disposal removes only its own scope.
   * @param provider - Scoped binding to actual parent-conversation tool receipts.
   * @returns disposer that removes only this adapter.
   */
  registerConversationWorkflow(provider: ConversationWorkflowProvider): () => void {
    if (!provider.id || !provider.toolNames.length) throw new Error('Conversation workflow requires an identity and actual tools')
    this.conversationProviders.add(provider)
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
    return () => { this.conversationProviders.delete(provider) }
  }

  private provider(agent: Agent, name?: string): ConversationWorkflowProvider | undefined {
    const providers = [...this.conversationProviders].filter(item => item.appliesTo(agent)
      && (name === undefined || item.toolNames.includes(name)))
    if (providers.length > 1) throw new Error('More than one conversation executor matches this profile')
    return providers[0]
  }
  private conversationRun(runtime: SessionRuntime): ProductionRun | undefined {
    return runtime.state.runs.findLast(item => item.mode === 'conversation' && item.phase !== 'complete')
  }
  private async mutate<T>(runtime: SessionRuntime, action: () => Promise<T>, allowSettlement = false): Promise<T> {
    const previous = runtime.mutationTail
    let release: (() => void) | undefined
    runtime.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (!allowSettlement && this.nativeLease?.settlement?.result.sessionId === runtime.agent.id) throw new Error('Native settlement publication is pending; reconcile the original invocation before modifying its run')
      if (!allowSettlement && (runtime.pendingPublication || runtime.state.pendingCheckpoints?.length)) {
        await this.publish(runtime, true)
        if (runtime.state.pendingCheckpoints?.length) throw new Error(runtime.publicationError ?? 'Checkpoint publication is pending; no new operation may start')
      }
      return await action()
    } finally { release?.() }
  }
  /** Quiescent conversation nodes pause; only an unsettled invocation becomes unknown. */
  private async stopRuntime(runtime: SessionRuntime, reason: string): Promise<void> {
    for (const run of runtime.state.runs) {
      for (const task of run.tasks.filter(item => item.phase === 'running')) {
        const inFlight = run.mode !== 'conversation' || task.operationId !== undefined
        this.transition(run, task, inFlight ? 'unknown' : 'paused', `${reason}; ${inFlight ? 'reconcile the exact invocation before continuing' : 'resume between known receipts without replay'}`)
      }
      this.updateRun(run)
      if (run.phase === 'active') run.phase = 'paused'
    }
    await this.publish(runtime, true)
  }
  /** An explicit UI resume/answer wakes the same parent without starting another run. */
  private wakeConversation(runtime: SessionRuntime, run: ProductionRun, continuation?: UserMessage): void {
    if (this.closing || run.mode !== 'conversation' || run.phase !== 'active' || runtime.pausedRun.has(run.id) || run.tasks.some(task => task.operationId || task.phase === 'human' || task.phase === 'unknown')) return
    if (!run.tasks.some(task => this.node(run, task.nodeId).kind === 'agent' && ['ready', 'running'].includes(task.phase))) return
    const message = continuation ?? createUserMessage({ content: [{ type: 'text', text: `The user explicitly released the workflow control for run ${run.id}. Continue this same run at its current graph node. Preserve its source binding, consumed routes, and remaining execution budget. Never repeat a settled invocation or start a second run.` }], source: { kind: 'user-approval' } })
    runtime.agent.steer(message)
  }
  /** Execute only graph-bound read-only checks; conversational agent nodes stay in the parent. */
  private async advanceConversation(runtime: SessionRuntime, run: ProductionRun): Promise<void> {
    if (this.closing || run.mode !== 'conversation' || runtime.pausedRun.has(run.id) || ['unknown', 'complete'].includes(run.phase)) return
    for (;;) {
      const ready = run.tasks.filter(item => item.phase === 'ready')
      if (!ready.length) return
      if (ready.length > 1) throw new Error('A conversation graph requires one executable next node; parallel agent branches have no second executor')
      const task = ready[0]
      if (!task) return
      const node = this.node(run, task.nodeId)
      if (node.kind === 'human' || node.config.breakBefore && !task.breakpointReleased) {
        task.breakpoint = 'before'
        if (node.kind === 'human') {
          const incoming = Object.values(task.incoming ?? {})
          task.output = incoming[0]?.data ?? null
          task.evidence = incoming.flatMap(item => item.evidence)
          task.certificates = [...new Set(incoming.flatMap(item => item.certificates))]
        }
        this.transition(run, task, 'human', node.config.question ?? 'Confirm before the next conversation step')
        this.updateRun(run); await this.publish(runtime); return
      }
      if (node.kind === 'agent') return
      if (run.executions >= run.graph.maxExecutions || task.attempts >= node.maxAttempts) { this.transition(run, task, 'blocked', 'Conversation graph execution budget exhausted'); this.updateRun(run); await this.publish(runtime); return }
      task.attempts++; run.executions++; task.startedAt = Date.now()
      this.transition(run, task, 'running', node.label)
      await this.publish(runtime)
      let result: NodeResult
      try { result = await this.perform(runtime.agent, run, node, task, new AbortController().signal) }
      catch (error: unknown) {
        result = { outlet: 'failure', data: { error: error instanceof Error ? error.message : String(error) },
          evidence: task.evidence, certificates: task.certificates, message: 'Read-only evidence check failed; no native operation was dispatched' }
      }
      task.output = result.data; task.evidence = result.evidence; task.certificates = result.certificates
      delete task.incoming; delete task.breakpointReleased
      if (node.config.breakAfter && result.outlet !== 'unknown') { task.breakpoint = 'after'; task.pendingOutlet = result.outlet; this.transition(run, task, 'human', 'Confirm before releasing the next graph step') }
      else { this.transition(run, task, result.outlet === 'success' ? 'complete' : result.outlet === 'unknown' ? 'unknown' : 'blocked', result.message); this.route(run, task, result.outlet) }
      this.activateQueued(run, task); this.updateRun(run)
      await this.publish(runtime, true)
      if (task.phase === 'human' || run.phase === 'unknown' || run.phase === 'complete') return
    }
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
    return this.mutate(runtime, async () => {
      const parsed = z.object({ expectedVersion: z.number().int().nonnegative(), graph: z.unknown() }).strict().parse(request)
      if (runtime.state.graph.version !== parsed.expectedVersion) throw new Error('Production graph changed; reload before saving')
      const graph = validateProductionGraph(parsed.graph)
      for (const protectedNode of runtime.state.graph.nodes.filter(item => item.protected)) {
        const replacement = graph.nodes.find(item => item.id === protectedNode.id)
        if (!replacement || replacement.kind !== protectedNode.kind || replacement.config.certification !== protectedNode.config.certification || replacement.protected !== true || replacement.config.expected !== protectedNode.config.expected || replacement.config.evidencePath !== protectedNode.config.evidencePath || replacement.config.toolName !== protectedNode.config.toolName || replacement.config.evidenceToolName !== protectedNode.config.evidenceToolName || JSON.stringify(replacement.config.arguments) !== JSON.stringify(protectedNode.config.arguments) || JSON.stringify(replacement.config.filePaths) !== JSON.stringify(protectedNode.config.filePaths) || JSON.stringify(replacement.config.fileHashes) !== JSON.stringify(protectedNode.config.fileHashes) || replacement.config.reconcileToolName !== protectedNode.config.reconcileToolName) throw new Error(`Mandatory node ${protectedNode.id} cannot be removed or weakened`)
      }
      graph.version = parsed.expectedVersion + 1
      const run = this.conversationRun(runtime)
      if (run) {
        validateConversationEdit(run, graph)
        const now = Date.now()
        run.tasks = graph.nodes.map(node => run.tasks.find(task => task.nodeId === node.id) ?? { nodeId: node.id, phase: graph.edges.some(edge => edge.toNode === node.id) ? 'waiting' : 'ready', attempts: 0, message: '', evidence: [], certificates: [], updatedAt: now })
        run.graph = structuredClone(graph); run.revision++; run.updatedAt = now
      } else if (this.provider(runtime.agent)) {
        const provider = this.provider(runtime.agent)
        if (!provider) throw new Error('Conversation adapter changed during graph validation')
        // An AEA draft is a future chat flow, not authorization to start a child.
        const draft: ProductionRun = { id: 'draft' as ProductionRunId, revision: 1, objective: 'draft', graph: createConversationGraph(this.limits.defaultMaxExecutions, provider.toolNames), phase: 'active', executions: 0, input: null, tasks: [], history: [], createdAt: 0, updatedAt: 0 }
        validateConversationEdit(draft, graph)
      }
      runtime.state.graph = graph
      const provider = this.provider(runtime.agent)
      if (provider) runtime.state.conversationProvider = provider.id
      await this.publish(runtime)
      return this.snapshot(runtime)
    })
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
    if (this.provider(runtime.agent) || this.conversationRun(runtime)) throw new Error('This profile executes its workflow directly through conversation; do not start a second run')
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
    return this.mutate(runtime, async () => {
      const run = this.expect(runtime, ref)
      const tasks = ref.nodeId ? [this.task(run, ref.nodeId)] : run.tasks
      if (run.mode === 'conversation') {
        runtime.pausedRun.add(run.id)
        // Pause admission, not an already-dispatched native operation. Its known
        // receipt must still settle into this same run before the next step.
        for (const task of tasks.filter(item => item.phase === 'ready' || item.phase === 'running' && !item.operationId)) this.transition(run, task, 'paused', 'Paused by the user; existing operation is not replayed')
        run.phase = 'paused'; run.revision++
        await this.publish(runtime); return this.snapshot(runtime)
      }
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
    })
  }

  /**
 * Resume only paused work; unknown work refuses replay.
 * @param sessionId - owning conversation.
 * @param ref - expected run revision and optional branch.
 * @param continuation - optional uniquely identified instructions for one idle paused conversation.
 * @returns committed state with the admitted continuation identity; uncertain delivery is never resent.
 */
  @Remote
  async resume(sessionId: SessionId, ref: ProductionRef, continuation?: ProductionContinuation): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    return this.mutate(runtime, async () => {
      const run = this.expect(runtime, ref)
      let continuationMessage: UserMessage | undefined
      if (continuation !== undefined) {
        const parsed = z.object({ requestId: z.uuid(), text: z.string().trim().min(1) }).strict().parse(continuation)
        if (this.nativeLease) throw new Error('Native execution is still leased; reconcile it before requesting continuation')
        if (run.mode !== 'conversation' || run.phase !== 'paused' || runtime.agent.status !== 'idle'
          || runtime.agent.inbox.nextStep.length || runtime.agent.inbox.nextTurn.length) throw new Error('A named continuation requires the original paused conversation and an idle, empty inbox')
        const requests = this.ctx.sessionProjections.stateOf(runtime.agent.session, 'productionContinuationRequests')
        if (!requests || requests[parsed.requestId] || runtime.state.runs.some(item => item.tasks.some(task => task.evidence.some(evidence => field(evidence.data, 'productionContinuation.requestId') === parsed.requestId)))) throw new Error('Continuation request is already admitted or its projection is unavailable; inspect the original message without resending')
        const task = run.tasks.find(item => (!ref.nodeId || item.nodeId === ref.nodeId) && item.phase === 'paused' && this.node(run, item.nodeId).kind === 'agent')
        if (!task || run.tasks.some(item => ['human', 'unknown'].includes(item.phase) || item.operationId)) throw new Error('No paused conversation agent node can accept this continuation')
        continuationMessage = createUserMessage({ content: [{ type: 'text', text: `The user explicitly released the workflow control for run ${run.id}. Continue this same run at its current graph node. Preserve its source binding, consumed routes, and remaining execution budget. Never repeat a settled invocation or start a second run.\n\n${parsed.text}` }], source: { kind: 'user-approval', rpcId: parsed.requestId } })
        if (Buffer.byteLength(JSON.stringify(continuationMessage)) > this.limits.maxEvidenceBytes) throw new Error('Continuation message exceeds the retained evidence limit')
        const evidence: ProductionEvidence = { kind: 'human', nodeId: task.nodeId, attempt: task.attempts,
          data: json({ productionContinuation: { ...parsed, messageId: continuationMessage.id } }), observedAt: Date.now() }
        this.assertEvidenceSize([...task.evidence, evidence])
        task.evidence.push(evidence)
      }
      const tasks = ref.nodeId ? [this.task(run, ref.nodeId)] : run.tasks
      if (ref.nodeId && tasks[0]?.phase === 'unknown') throw new Error('Unknown operation cannot be replayed; use reconcile')
      if (run.mode === 'conversation' && run.tasks.some(item => item.phase === 'unknown')) throw new Error('Unknown operation cannot be replayed; reconcile the exact existing receipt')
      if (!ref.nodeId || run.mode === 'conversation') runtime.pausedRun.delete(run.id)
      for (const task of tasks.filter(item => item.phase === 'paused')) {
        const node = this.node(run, task.nodeId)
        this.transition(run, task, task.breakpoint || node.kind === 'human' ? 'human' : run.mode === 'conversation' && task.attempts > 0 && task.startedAt !== undefined ? 'running' : this.hasInputs(node, task, run) ? 'ready' : 'waiting', 'Resumed by the user')
      }
      this.updateRun(run)
      await this.publish(runtime)
      if (run.mode === 'conversation') await this.advanceConversation(runtime, run)
      this.schedule(runtime)
      if (continuationMessage && (runtime.pendingPublication || runtime.state.pendingCheckpoints?.length || runtime.publicationError)) throw new Error('Continuation admission checkpoint is pending; inspect the original request without resending')
      this.wakeConversation(runtime, run, continuationMessage)
      return this.snapshot(runtime)
    })
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
    return this.mutate(runtime, async () => {
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
      if (run.mode === 'conversation') await this.advanceConversation(runtime, run)
      this.schedule(runtime)
      this.wakeConversation(runtime, run)
      return this.snapshot(runtime)
    })
  }

  /**
   * Register a read-only Host resolver for original native invocations.
   * @param provider - Trusted plugin adapter; overlapping tool registrations refuse reconciliation.
   * @returns effect disposer removing only this registration.
   */
  registerNativeReconciliationProvider(provider: NativeReconciliationProvider): () => void {
    this.reconciliationProviders.add(provider)
    return () => { this.reconciliationProviders.delete(provider) }
  }

  /**
   * Settle one exact unknown invocation from Host evidence without replay or budget changes.
   * @param sessionId - owning conversation.
   * @param ref - compare-and-set run revision and unknown branch.
   * @returns paused original node, or unchanged unknown state when the Host cannot resolve it.
   */
  @Remote
  async reconcile(sessionId: SessionId, ref: ProductionRef): Promise<ProductionSnapshot> {
    return this.reconcileInvocation(sessionId, ref, false)
  }

  private async reconcileInvocation(sessionId: SessionId, ref: ProductionRef, automatic: boolean): Promise<ProductionSnapshot> {
    const runtime = await this.runtime(sessionId)
    return this.mutate(runtime, async () => {
      const run = this.expect(runtime, ref)
      if (!ref.nodeId) throw new Error('Reconciliation requires one unknown node')
      const task = this.task(run, ref.nodeId)
      const wasPaused = runtime.pausedRun.has(run.id)
      const previous = this.nativeTail
      let release: (() => void) | undefined
      this.nativeTail = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        const lease = this.nativeLease
        if (!lease || lease.status !== 'unknown' || lease.sessionId !== sessionId
          || lease.operationId !== (task.operationId ?? task.settledOperationId)) throw new Error('No matching unknown native lease belongs to this task')
        if (task.phase !== 'unknown' && !(task.phase === 'paused' && lease.settlement)) throw new Error('Only an unknown operation or its pending settlement requires reconciliation')
        if (!lease.settlement && !this.reconciliationProvidersFor(sessionId, lease.toolName).length) throw new Error('No Host provider can bind this interrupted operation to its exact native receipt; quarantine remains')
        const request = this.reconciliationRequest(runtime, run, task, lease)
        let settlement = lease.settlement
        if (!settlement) {
          const providers = this.reconciliationProvidersFor(sessionId, lease.toolName)
          if (!providers.length) throw new Error('No Host provider can bind this interrupted operation to its exact native receipt; quarantine remains')
          if (providers.length !== 1) throw new Error('More than one Host reconciliation provider matches this native tool')
          const provider = providers[0]
          if (!provider) throw new Error('No Host reconciliation provider is available')
          const result: NativeReconciliationResult = await provider.reconcile(structuredClone(request))
          const parsed = reconciliationResultSchema.parse(result)
          if (parsed.sessionId !== request.sessionId || parsed.operationId !== request.operationId
            || parsed.toolName !== request.toolName || parsed.argumentSha256 !== request.argumentSha256) throw new Error('Host reconciliation identity does not match the original invocation')
          const currentProviders = this.reconciliationProvidersFor(sessionId, lease.toolName)
          if (this.closing || currentProviders.length !== 1 || currentProviders[0] !== provider) throw new Error('Host reconciliation provider changed before settlement')
          if (parsed.outcome === 'unknown') return this.snapshot(runtime)
          const current = this.reconciliationRequest(runtime, run, task, lease)
          if (this.eventSha(current.callEvent) !== this.eventSha(request.callEvent)
            || (current.resultEvent ? this.eventSha(current.resultEvent) : undefined) !== (request.resultEvent ? this.eventSha(request.resultEvent) : undefined)) throw new Error('Original Session invocation changed during reconciliation')
          settlement = { providerId: provider.id, runId: run.id, nodeId: task.nodeId, runRevision: run.revision,
            attempts: task.attempts, executions: run.executions, callEventSha256: this.eventSha(request.callEvent),
            ...(request.resultEvent ? { resultEventSha256: this.eventSha(request.resultEvent) } : {}),
            preparedAt: Date.now(), result: parsed }
          this.assertEvidenceSize([...task.evidence, { kind: 'tool', nodeId: task.nodeId, attempt: task.attempts,
            toolName: lease.toolName, data: json({ nativeReconciliation: settlement }), observedAt: settlement.preparedAt }])
          const prepared = { ...lease, settlement }
          await (await this.domain).table('native').put('Rhino', prepared)
          this.nativeLease = prepared
        }
        if (settlement.runId !== run.id || settlement.nodeId !== task.nodeId || settlement.attempts !== task.attempts
          || settlement.executions !== run.executions || settlement.callEventSha256 !== this.eventSha(request.callEvent)
          || settlement.resultEventSha256 !== (request.resultEvent ? this.eventSha(request.resultEvent) : undefined)) throw new Error('Persisted native settlement no longer matches its original task and events')
        if (task.phase === 'unknown') {
          if (run.revision !== settlement.runRevision) throw new Error('Production run changed after native settlement was prepared')
          delete task.operationId
          task.settledOperationId = lease.operationId
          task.evidence.push({ kind: 'tool', nodeId: task.nodeId, attempt: task.attempts, toolName: lease.toolName,
            data: json({ nativeReconciliation: settlement }), observedAt: settlement.preparedAt })
          runtime.pausedRun.add(run.id)
          this.transition(run, task, 'paused', settlement.result.outcome === 'rejected_before_native'
            ? 'Host confirmed rejection before native execution; resume the same node without repeating the rejected call'
            : 'Host confirmed the original native result; resume the same node using its retained receipt')
          this.updateRun(run); run.phase = 'paused'
          await this.publish(runtime, true)
        } else {
          const recorded = task.evidence.some(item => JSON.stringify(field(item.data, 'nativeReconciliation')) === JSON.stringify(settlement))
          if (!recorded || run.revision !== settlement.runRevision + 1) throw new Error('Pending native settlement is not committed to this task')
          await this.publish(runtime, true)
        }
        if (runtime.pendingPublication || runtime.state.pendingCheckpoints?.length || runtime.publicationError) throw new Error('Native settlement checkpoint is pending; quarantine remains until publication succeeds')
        await (await this.domain).table('native').delete('Rhino')
        this.nativeLease = undefined
        if (automatic && !wasPaused && run.mode === 'conversation' && settlement.result.outcome === 'rejected_before_native') {
          runtime.pausedRun.delete(run.id)
          this.transition(run, task, 'running', 'Host confirmed rejection before native execution; continue from the error receipt without repeating the rejected call')
          this.updateRun(run)
          await this.publish(runtime, true)
        }
        for (const listener of this.listeners.get(sessionId) ?? []) { try { listener() } catch (error: unknown) { this.ctx.logger.warn('Production Studio subscriber failed', error) } }
        return this.snapshot(runtime)
      } finally { release?.() }
    }, true)
  }

  private reconciliationProvidersFor(sessionId: SessionId, toolName: string): NativeReconciliationProvider[] {
    return [...this.reconciliationProviders].filter(provider => provider.toolNames.includes(toolName)
      && (provider.appliesTo === undefined || provider.appliesTo(sessionId)))
  }

  private eventSha(event: SessionEvent): string { return createHash('sha256').update(JSON.stringify(event)).digest('hex') }

  private reconciliationRequest(
    runtime: SessionRuntime, run: ProductionRun, task: ProductionTask, lease: NativeLease,
  ): NativeReconciliationRequest {
    const invocations = this.ctx.sessionProjections.stateOf(runtime.agent.session, 'productionNativeInvocations')
    const invocation = invocations?.[lease.operationId]
    const call = invocation?.callEvent, result = invocation?.resultEvent
    if (!invocation || invocation.callCount !== 1 || !call || call.data.name !== lease.toolName || invocation.resultCount > 1
      || !runtime.agent.session.isOwnSeq(call.seq)
      || result && (result.seq <= call.seq || result.data.turn !== call.data.turn || result.data.step !== call.data.step)) throw new Error('Original Session invocation is missing, duplicated or mismatched')
    return structuredClone({ sessionId: runtime.agent.id, operationId: lease.operationId, toolName: lease.toolName,
      argumentSha256: createHash('sha256').update(call.data.arguments).digest('hex'), arguments: json(JSON.parse(call.data.arguments)),
      callEvent: call, ...(result ? { resultEvent: result } : {}), runId: run.id, nodeId: task.nodeId, runRevision: run.revision,
      run, task, lease: { status: 'unknown', dispatched: lease.dispatched, markerSupported: lease.markerSupported, observedAt: lease.observedAt } })
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
      mutationTail: Promise.resolve(),
    }
    this.runtimes.set(sessionId, runtime)
    let recovered = false
    for (const run of state.runs) {
      let hadInFlight = false
      if (run.phase === 'paused') runtime.pausedRun.add(run.id)
      for (const task of run.tasks.filter(item => item.phase === 'running')) {
        const inFlight = run.mode !== 'conversation' || task.operationId !== undefined
        this.transition(run, task, inFlight ? 'unknown' : 'paused', inFlight ? 'Host restarted with an in-flight operation; reconcile before continuing' : 'Conversation stopped between known tool receipts; resume without replay')
        hadInFlight ||= inFlight; recovered = true
      }
      if (run.phase === 'active') { run.phase = hadInFlight ? 'unknown' : 'paused'; runtime.pausedRun.add(run.id); recovered = true }
    }
    if (recovered || state.pendingCheckpoints?.length) {
      await this.mutate(runtime, () => this.publish(runtime, true), true)
    }
    return runtime
  }

  /** Build detached UI data from committed state and current capabilities. */
  private snapshot(runtime: SessionRuntime): ProductionSnapshot {
    const state = structuredClone(runtime.committed)
    const provider = this.provider(runtime.agent)
    if (provider && state.conversationProvider !== provider.id) {
      state.graph = createConversationGraph(this.limits.defaultMaxExecutions, provider.toolNames)
    }
    return { sessionId: runtime.agent.id, revision: state.revision, graph: state.graph, runs: state.runs, capabilities: { subagent: this.ctx.subagents.list().includes(this.limits.subagentProvider), tools: [...this.ctx.tools.schemas(runtime.agent).map(tool => tool.name), 'production_aea_evidence'], filesystem: true, ...(provider ? { conversation: { provider: provider.id } } : {}) }, ...(runtime.publicationError ? { error: runtime.publicationError } : this.nativeLease?.status === 'unknown' ? { error: this.nativeLease.message } : {}) }
  }

  /** Commit before notifying UI subscribers. */
  private async publish(runtime: SessionRuntime, preserveReceipt = false): Promise<void> {
    const previousState = runtime.committed
    if (!runtime.pendingPublication) runtime.state.revision++
    for (const run of runtime.state.runs.filter(item => item.mode === 'conversation')) {
      const previous = previousState.runs.find(item => item.id === run.id)
      const queued = runtime.state.pendingCheckpoints?.some(item => item.id === run.id && item.revision === run.revision)
      if ((!previous || previous.revision !== run.revision) && !queued) {
        runtime.state.pendingCheckpoints ??= []; runtime.state.pendingCheckpoints.push(structuredClone(run))
      }
    }
    // A returned receipt can enrich an older pending control-state write.
    // Always persist the current authoritative settlement, not a stale retry snapshot.
    const state = decodeProductionState(runtime.state)
    const domain = await this.domain
    try { await domain.table('sessions').put(runtime.agent.id, state) }
    catch (error: unknown) {
      if (preserveReceipt) { runtime.pendingPublication = structuredClone(state); runtime.publicationError = 'Known execution receipt retained; storage failed and no next operation may start until settlement commits' }
      else runtime.state = structuredClone(runtime.committed)
      throw error
    }
    delete runtime.pendingPublication
    runtime.committed = structuredClone(state)
    delete runtime.publicationError
    const pending = [...runtime.state.pendingCheckpoints ?? []]
    while (runtime.state.pendingCheckpoints?.length) {
      try {
        const checkpoint = runtime.state.pendingCheckpoints[0]
        if (!checkpoint) break
        const accepted = this.ctx.sessionProjections.stateOf(runtime.agent.session, 'productionCheckpoints')
        if (!accepted) throw new Error('Checkpoint cursor projection is unavailable')
        if ((accepted[checkpoint.id] ?? 0) < checkpoint.revision) runtime.agent.session.append('production/checkpoint', { run: checkpoint }, { ignorable: true })
        if (!await this.ctx.sessions.flush(runtime.agent.session)) throw new Error('Checkpoint Session was not durably flushed')
        runtime.state.pendingCheckpoints.shift()
      }
      catch (error: unknown) { runtime.publicationError = 'Execution settlement is saved; conversation/trajectory checkpoint publication is pending'; this.ctx.logger.error('Production Studio checkpoint publication failed', error); break }
    }
    if (pending.length && runtime.state.pendingCheckpoints?.length !== pending.length) {
      if (!runtime.state.pendingCheckpoints?.length) delete runtime.state.pendingCheckpoints
      try { await domain.table('sessions').put(runtime.agent.id, decodeProductionState(runtime.state)); runtime.committed = structuredClone(runtime.state) }
      catch (error: unknown) { runtime.state.pendingCheckpoints = pending; runtime.publicationError = 'Checkpoint appended; outbox acknowledgement is pending and will retry without duplicate history'; this.ctx.logger.error('Production Studio outbox acknowledgement failed', error) }
    }
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
    if (['human', 'running', 'paused', 'unknown'].includes(task.phase)
      || ['human', 'running', 'paused'].includes(phase)) task.admitted = true
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
          if (run.mode === 'conversation') continue
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
        const receipt = evidence.filter(item => item.kind === 'tool' && (['get_case_context', 'begin_workflow', 'compare_candidates', 'finalize_candidate', 'submit_baseline', 'submit_revision', 'try_suggestion'].includes(item.toolName ?? '') || run.mode === 'conversation' && this.provider(agent)?.toolNames.includes(item.toolName ?? '')) && field(item.data, 'workflow') !== undefined).at(-1)
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
