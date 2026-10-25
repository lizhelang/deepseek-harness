import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StudioInjected } from '../src/client/slots.ts'
import { en } from '../src/client/locales.ts'
import { SID, run, snapshot } from './fixtures.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

describe('production Studio registration lifecycle', () => {
  it('waits for declared conversation slots and removes every contribution on HMR disposal', async () => {
    const ctx = new Context()
    const registryFiber = ctx.plugin(SlotRegistry)
    await registryFiber.await()
    ctx.provide('sessions', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    const conversation = new UiConversation(ctx, ctx.sessions)
    const events = conversation.events
    ctx.provide('remote', { productionStudio: {} })
    ctx.provide('remote.productionStudio', {})
    const fiber = ctx.plugin({ inject, apply })
    try {
      await fiber.await()
      expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
      expect(events.entries().map(entry => entry.kind)).toEqual(['production-chat-checkpoint', 'production-trajectory-checkpoint'])
      ctx.slots.register({ name: 'root', children: {
        'conversation.view': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      } } as never, () => null)
      await Promise.resolve()
      expect(ctx.slots.entries('conversation.view').map(entry => entry.options.id)).toEqual(['production-monitor', 'production-workflow'])
      expect(ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual(['production-studio'])
      expect(ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)).toEqual(['production-checkpoint'])
    } finally { await fiber.dispose() }
    expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(0)
    expect(events.entries()).toHaveLength(0)
    await registryFiber.dispose()
  })
  it('reports an unchanged unknown reconciliation through the registered session action', async () => {
    const ctx = new Context()
    const registryFiber = ctx.plugin(SlotRegistry)
    await registryFiber.await()
    ctx.provide('sessions', { using: async (_id: SessionId, _options: object, operation: () => Promise<unknown>) => operation() })
    ctx.provide('locale', new LocaleRuntime(ctx))
    new UiConversation(ctx, ctx.sessions)
    const pending = run('unresolved', 'unknown')
    const reconcile = vi.fn(async () => ({ ok: true, value: snapshot([pending]) }))
    ctx.provide('remote', { productionStudio: { reconcile } })
    ctx.provide('remote.productionStudio', { reconcile })
    const fiber = ctx.plugin({ inject, apply })
    try {
      await fiber.await()
      ctx.slots.register({ name: 'root', children: {
        'conversation.view': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      } } as never, () => null)
      await Promise.resolve()
      const entry = ctx.slots.entries('conversation.view').find(item => item.options.id === 'production-monitor')!
      const actions: Partial<StudioInjected> = entry.inject!(SID as never)
      if (!actions.reconcile || !actions.hooks) throw new Error('Monitor session actions were not registered')
      const ref = { runId: pending.id, revision: pending.revision, nodeId: 'baseline' }
      expect(await actions.reconcile(ref)).toBe(en['branch.reconcileUnresolved'])
      expect(reconcile).toHaveBeenCalledWith(SID, ref)
      expect(actions.hooks.production.getSnapshot().snapshot?.runs[0]?.tasks[0]?.phase).toBe('unknown')
      pending.tasks[0]!.phase = 'paused'
      expect(await actions.reconcile(ref)).toBeNull()
    } finally { await fiber.dispose(); await registryFiber.dispose() }
  })
  it('keeps the Host carrier free of execution behavior', () => {
    expect(hostApply).not.toThrow()
  })
})
