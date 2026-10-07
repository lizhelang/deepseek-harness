import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

describe('production Studio registration lifecycle', () => {
  it('waits for declared conversation slots and removes every contribution on HMR disposal', async () => {
    const ctx = new Context()
    const registryFiber = ctx.plugin(SlotRegistry)
    await registryFiber.await()
    ctx.provide('sessions', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('remote', { productionStudio: {} })
    ctx.provide('remote.productionStudio', {})
    const fiber = ctx.plugin({ inject, apply })
    try {
      await fiber.await()
      expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
      ctx.slots.register({ name: 'root', children: {
        'conversation.view': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      } } as never, () => null)
      await Promise.resolve()
      expect(ctx.slots.entries('conversation.view').map(entry => entry.options.id)).toEqual(['production-monitor', 'production-workflow'])
      expect(ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual(['production-studio'])
    } finally { await fiber.dispose() }
    expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
    await registryFiber.dispose()
  })
  it('keeps the Host carrier free of execution behavior', () => {
    expect(hostApply).not.toThrow()
  })
})
