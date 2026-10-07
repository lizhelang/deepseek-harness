import { describe, expect, it, vi } from 'vitest'
import type { ProductionSnapshot } from '@deepseek-ai/dsh-production-studio/types'
import { createProductionSource } from '../src/client/production-source.ts'
import { snapshot } from './fixtures.ts'

describe('actual production follow source', () => {
  it('retains a newer stream frame when the initial read settles late and aborts on unmount', async () => {
    let resolveRead!: (value: ProductionSnapshot) => void
    let resolveFollow!: (value: IteratorResult<ProductionSnapshot>) => void
    let signal: AbortSignal | undefined
    const resetDispose = vi.fn()
    const source = createProductionSource({
      get: () => new Promise((resolve) => { resolveRead = resolve }),
      follow: (nextSignal) => {
        signal = nextSignal
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => { resolveFollow = resolve }) }) }
      },
      subscribeReset: () => resetDispose,
    })
    const listener = vi.fn()
    const release = source.subscribe(listener)
    resolveFollow({ done: false, value: { ...snapshot(), revision: 8 } })
    await Promise.resolve(); await Promise.resolve()
    resolveRead({ ...snapshot(), revision: 2 })
    await Promise.resolve()
    expect(source.getSnapshot().snapshot?.revision).toBe(8)
    expect(source.getSnapshot().loading).toBe(false)
    release()
    expect(signal?.aborted).toBe(true)
    expect(resetDispose).toHaveBeenCalledOnce()
    resolveFollow({ done: true, value: undefined })
    source.dispose()
  })
  it('reports actual read failures and shares one stream across multiple views', async () => {
    const get = vi.fn().mockRejectedValue(new Error('native service disconnected'))
    const follow = vi.fn(async function* () { yield snapshot() })
    const source = createProductionSource({ get, follow, subscribeReset: () => () => {} })
    const release = source.subscribe(() => {})
    const other = source.subscribe(() => {})
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(get).toHaveBeenCalledOnce()
    expect(follow).toHaveBeenCalledOnce()
    source.publish({ ...snapshot(), revision: 10 })
    source.publish({ ...snapshot(), revision: 9 })
    expect(source.getSnapshot().snapshot?.revision).toBe(10)
    release(); other(); source.dispose()
  })
})
