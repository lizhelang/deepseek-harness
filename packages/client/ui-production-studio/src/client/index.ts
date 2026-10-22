/** Session task monitor, compact composer dock and editable production graph. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductionSnapshot } from '@deepseek-ai/dsh-production-studio/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { createProductionSource, type ProductionSource } from './production-source.ts'
import { createStudioDraftStore } from './stores.ts'
import { ProductionMonitorView, ProductionDock } from './TaskMonitor.tsx'
import { ProductionWorkflowView } from './WorkflowEditor.tsx'
import { en, zh, type ProductionStudioKey } from './locales.ts'
import type { StudioInjected } from './slots.ts'
import { productionChatDefinition, productionTrajectoryDefinition } from './checkpoint.ts'
import { ProductionCheckpointView } from './ProductionCheckpoint.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Production monitoring and node editing copy. */
    productionStudio: ProductionStudioKey
  }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A Studio read or live-follow stream retaining the current Session. */
    productionStudio: unknown
  }
}

/** Required registry, Session, locale and generated production API services. */
export const inject = ['slots', 'sessions', 'locale', 'uiConversation', 'remote', 'remote.productionStudio']

/**
 * Install three surfaces sharing one Session stream and draft store. Registrations
 * wait for their declaring slots and unwind with the plugin during HMR.
 * @param ctx - Client root context, kept out of presentation components.
 */
export function apply(ctx: Context): void {
  const namespace = 'productionStudio'
  const t = ctx.locale.bind(namespace)
  const store = createStudioDraftStore()
  const sources = new Map<SessionId, ProductionSource>()
  const remote = ctx.remote.productionStudio
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'ui-production-studio: dictionaries')
  ctx.uiConversation.events.register(productionChatDefinition)
  ctx.uiConversation.events.register(productionTrajectoryDefinition(t))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'production-checkpoint', locale: namespace,
  }, ProductionCheckpointView))
  ctx.effect(() => () => { for (const source of sources.values()) source.dispose(); sources.clear() }, 'ui-production-studio: streams')
  const unwrap = (result: RemoteResult<ProductionSnapshot>): ProductionSnapshot => {
    if (!result.ok) throw result.error
    return result.value
  }
  const sourceFor = (sessionId: SessionId): ProductionSource => {
    let source = sources.get(sessionId)
    if (source !== undefined) return source
    source = createProductionSource({
      get: () => ctx.sessions.using(sessionId, { source: 'productionStudio' }, async () => unwrap(await remote.get(sessionId))),
      async *follow(signal) {
        const reference = ctx.sessions.retain(sessionId, { source: 'productionStudio', signal })
        try {
          await reference.ready
          for await (const snapshot of remote.follow(sessionId, signal)) yield snapshot
        } finally { reference.release() }
      },
      subscribeReset: listener => ctx.on('connection/reset', listener),
    })
    sources.set(sessionId, source)
    return source
  }
  const injected = (sessionId: SessionId): StudioInjected => {
    const source = sourceFor(sessionId)
    const settle = async (operation: () => Promise<RemoteResult<ProductionSnapshot>>): Promise<string | null> => {
      const result = await ctx.sessions.using(sessionId, { source: 'productionStudio' }, operation)
      if (!result.ok) return `${result.error.message} (${result.error.code})`
      source.publish(result.value)
      return null
    }
    return {
      hooks: { production: source },
      saveGraph: (expectedVersion, graph) => settle(() => remote.saveGraph(sessionId, { expectedVersion, graph })),
      start: request => settle(() => remote.start(sessionId, request)),
      pause: request => settle(() => remote.pause(sessionId, request)),
      resume: request => settle(() => remote.resume(sessionId, request)),
      answer: request => settle(() => remote.answer(sessionId, request)),
      reconcile: request => settle(() => remote.reconcile(sessionId, request)),
      async send(text) {
        const scope = ctx.sessions.scope(sessionId)
        if (scope === undefined) return `Session ${sessionId} is not open`
        try { await scope.conversation.send(text); return null }
        catch (error: unknown) { return error instanceof Error ? error.message : String(error) }
      },
      refresh: source.refresh,
    }
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'production-studio', order: 20,
    locale: namespace, store, inject: injected,
  }, ProductionDock))
  ctx.slots.inject('conversation.view', function* () {
    yield ctx.slots.register({ name: 'conversation.view', id: 'production-monitor', order: 20,
      locale: namespace, label: () => t('view.monitor'), store, inject: injected,
    }, ProductionMonitorView)
    yield ctx.slots.register({ name: 'conversation.view', id: 'production-workflow', order: 30,
      locale: namespace, label: () => t('view.editor'), store, inject: injected,
    }, ProductionWorkflowView)
  })
}
