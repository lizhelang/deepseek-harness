// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatSettings } from '../src/chat-settings.ts'
import { estimateTokenCost, formatCost } from '../src/client/chat/token-cost.ts'
import { DEFAULT_TOKEN_PRICING, TokenPricingPolicy } from '../src/client/token-pricing.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

const usage = (model: string, input: number, cacheRead: number, output: number, cacheWrite = 0) => ({
  model, uncachedInputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, cacheWriteTokens: cacheWrite,
})

describe('token cost estimate', () => {
  it('prices each bucket at its model rate per million tokens', () => {
    const estimate = estimateTokenCost([
      usage('deepseek-flash', 1_000_000, 2_000_000, 100_000, 1_000_000),
      usage('deepseek-v4-pro', 1_000_000, 0, 0),
      usage('unbilled-model', 0, 0, 0),
    ], DEFAULT_TOKEN_PRICING)
    if (estimate.kind !== 'priced') throw new Error('expected a priced estimate')
    const expected = { input: 12, cacheRead: 0.2, cacheWrite: 3, output: 0.9, total: 16.1 }
    for (const [bucket, amount] of Object.entries(expected)) {
      expect(estimate.cost[bucket as keyof typeof expected]).toBeCloseTo(amount, 9)
    }
  })

  it('converts to US dollars at the configured rate', () => {
    const estimate = estimateTokenCost([usage('deepseek-flash', 2_000_000, 0, 0)], {
      ...DEFAULT_TOKEN_PRICING, costCurrency: 'USD', cnyPerUsd: 6,
    })
    expect(estimate).toEqual({ kind: 'priced', cost: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, total: 1 } })
  })

  it('names every billing model without a price instead of under-reporting', () => {
    expect(estimateTokenCost([
      usage('deepseek-flash', 1, 0, 0),
      usage('other', 1, 0, 0),
      usage('', 1, 0, 0),
      usage('other', 0, 0, 1),
    ], DEFAULT_TOKEN_PRICING)).toEqual({ kind: 'unpriced', models: ['other', ''] })
  })

  it('formats cents, sub-cent amounts, and zero with the currency symbol', () => {
    expect(formatCost(12.345, 'CNY', t)).toBe('¥12.35')
    expect(formatCost(0, 'USD', t)).toBe('$0.00')
    expect(formatCost(0.000_314, 'CNY', t)).toBe('¥0.00031')
    expect(formatCost(0.004_6, 'USD', t)).toBe('$0.0046')
    expect(formatCost(0.000_009, 'CNY', t)).toBe('¥0.000009')
  })
})

describe('TokenPricingPolicy', () => {
  it('adopts accepted Host pricing and persists each changed field', () => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TokenPricingPolicy(host.scope)
    expect(policy.pricing.getSnapshot()).toBe(DEFAULT_TOKEN_PRICING)
    const prices = [{ model: 'm', cacheHit: 1, input: 2, output: 3 }]
    host.publish({ value: {
      linkOpening: 'sidebar', performanceUsage: 'detailed', costCurrency: 'USD', cnyPerUsd: 7, modelPrices: prices,
    } })
    expect(policy.pricing.getSnapshot()).toEqual({ costCurrency: 'USD', cnyPerUsd: 7, modelPrices: prices })
    policy.set('costCurrency', 'CNY')
    expect(policy.pricing.getSnapshot().costCurrency).toBe('CNY')
    expect(host.set).toHaveBeenCalledWith('costCurrency', 'CNY')
    policy.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('keeps a local choice when persistence rejects', async () => {
    const host = stubConfigForm<ChatSettings>()
    host.set.mockRejectedValueOnce(new Error('offline'))
    const policy = new TokenPricingPolicy(host.scope)
    policy.set('cnyPerUsd', 7.2)
    await Promise.resolve()
    expect(policy.pricing.getSnapshot().cnyPerUsd).toBe(7.2)
  })
})
