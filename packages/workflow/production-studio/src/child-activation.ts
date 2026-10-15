/** Production node execution through reserved, one-shot local activations. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { SubagentActivation, SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'

const CHILD_PREFIX = 'production-studio-child-'

/** One run attempt owns the child identity, observations, cancellation, and cleanup. */
export interface ProductionChild extends SubagentActivation {
  readonly events: readonly SessionEvent[]
}

/** Immutable scheduler identity of the node invocation that owns a reservation. */
export interface ProductionChildAttempt {
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
}

interface Reservation {
  readonly parent: Agent
  readonly attempt: ProductionChildAttempt
  readonly allowed: ReadonlySet<string> | undefined
  readonly disposers: (() => void)[]
  created?: Agent
  firstLiveSeq?: number
}

/** While Production Studio is mounted, only its current reservations may execute production children. */
export class ProductionChildren {
  private readonly reservations = new Map<SessionId, Reservation>()

  /** @param ctx - Plugin fiber owning the live reservation policy. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => ctx.tools.guard((exec) => {
      if (!exec.agent?.id.startsWith(CHILD_PREFIX)) return
      const reservation = this.reservations.get(exec.agent.id)
      if (!reservation || reservation.created !== exec.agent || !this.permits(reservation, exec.name)) {
        return 'Production child is closed or its node does not allow this tool'
      }
    }))
    ctx.on('agent/created', ({ agent }) => {
      if (!agent.id.startsWith(CHILD_PREFIX)) return
      const reservation = this.reservations.get(agent.id)
      if (!reservation || reservation.created || agent.session.header.parentSession !== reservation.parent.id
        || ctx.agents.get(reservation.parent.id) !== reservation.parent) {
        throw new Error('Production child has no matching live run attempt; completed or interrupted children cannot resume')
      }
      if (reservation.allowed) {
        reservation.disposers.push(agent.ctx.tools.restrict({ allow: [...reservation.allowed] }))
        reservation.disposers.push(agent.ctx.tools.guard(exec => this.permits(reservation, exec.name)
          ? undefined : 'Production node does not allow this tool'))
      }
      reservation.firstLiveSeq = agent.session.firstLiveSeq
      reservation.created = agent
    })
    ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembled = await next()
      if (!agent?.id.startsWith(CHILD_PREFIX)) return assembled
      const reservation = this.reservations.get(agent.id)
      if (!reservation || reservation.created !== agent) throw new Error('Production child has no active run attempt')
      return reservation.allowed
        ? { ...assembled, tools: assembled.tools.filter(tool => this.permits(reservation, tool.name)) } : assembled
    })
  }

  private permits(reservation: Reservation, name: string): boolean {
    return reservation.allowed === undefined || reservation.allowed.has(name)
      || reservation.allowed.size > 0 && name === RUN_CODE_NAME
  }

  /**
   * Install the node capability policy before the reserved child's queued work is released.
   * @param spec - Caller-delivered activation with the exact live parent.
   * @param attempt - Immutable run, node, and attempt identity supplied by the scheduler.
   * @param tools - Optional node capability allowlist; an empty list forbids all tools and code transport.
   * @returns The exact activation and its new live tool observations.
   */
  async start(
    spec: Omit<SubagentActivationSpec, 'childId' | 'delivery'>, attempt: ProductionChildAttempt, tools?: readonly string[],
  ): Promise<ProductionChild> {
    const childId = SessionId(`${CHILD_PREFIX}${randomUUID()}`)
    const events: SessionEvent[] = []
    const reservation: Reservation = { parent: spec.request.parent, attempt: { ...attempt },
      allowed: tools === undefined ? undefined : new Set(tools), disposers: [] }
    this.reservations.set(childId, reservation)
    const release = () => {
      this.reservations.delete(childId)
      for (const dispose of reservation.disposers.splice(0).reverse()) dispose()
    }
    reservation.disposers.push(this.ctx.on('session/event', (session, event) => {
      if (session.id !== childId || session.header.parentSession !== reservation.parent.id
        || reservation.firstLiveSeq === undefined || event.seq < reservation.firstLiveSeq) return
      if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') events.push(event)
    }))
    let activation: SubagentActivation
    try {
      activation = await this.ctx.subagents.startActivation({ ...spec, childId, mode: 'one-shot', delivery: 'caller' })
      if (!reservation.created || activation.childId !== childId || !activation.messageId) {
        await activation.dispose()
        throw new Error('Production child activation did not confirm its reserved identity and initial message')
      }
    } catch (error: unknown) { release(); throw error }
    let cancellation: Promise<void> | undefined
    const cancel = () => {
      cancellation ??= activation.dispose()
      void cancellation.catch(() => { /* dispose reports cleanup failure to this operation's owner. */ })
    }
    spec.signal.addEventListener('abort', cancel, { once: true })
    if (spec.signal.aborted) cancel()
    return { childId, messageId: activation.messageId, result: activation.result, events,
      async dispose() {
        spec.signal.removeEventListener('abort', cancel)
        try { await (cancellation ?? activation.dispose()) } finally { release() }
      },
    }
  }
}
