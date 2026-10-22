import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TokenPricing } from '../token-pricing.ts'

/** Billed token buckets of one model. */
export interface ModelUsage extends TokenUsageProjection {
  readonly model: string
}

/** Estimated cost per billing bucket, in the display currency. */
export interface TokenCost {
  readonly input: number
  readonly cacheRead: number
  /** Charged at the uncached input rate. */
  readonly cacheWrite: number
  readonly output: number
  readonly total: number
}

/** Cost estimate, or the models that billed tokens without a configured price. */
export type TokenCostEstimate =
  | { readonly kind: 'priced'; readonly cost: TokenCost }
  | { readonly kind: 'unpriced'; readonly models: readonly string[] }

const PER_MILLION = 1_000_000

/**
 * Price usage at the configured per-model rates, converted to the display currency.
 * @param usage - billed buckets per model; models with no tokens need no price.
 * @param pricing - configured yuan rates, display currency, and exchange rate.
 * @returns the summed cost, or every billing model that has no price.
 */
export function estimateTokenCost(usage: readonly ModelUsage[], pricing: TokenPricing): TokenCostEstimate {
  const scale = pricing.costCurrency === 'USD' ? 1 / (pricing.cnyPerUsd * PER_MILLION) : 1 / PER_MILLION
  const unpriced: string[] = []
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  for (const entry of usage) {
    if (entry.uncachedInputTokens + entry.cacheReadTokens + entry.cacheWriteTokens + entry.outputTokens === 0) continue
    const price = pricing.modelPrices.find(candidate => candidate.model === entry.model)
    if (price === undefined) {
      if (!unpriced.includes(entry.model)) unpriced.push(entry.model)
      continue
    }
    input += entry.uncachedInputTokens * price.input * scale
    cacheRead += entry.cacheReadTokens * price.cacheHit * scale
    cacheWrite += entry.cacheWriteTokens * price.input * scale
    output += entry.outputTokens * price.output * scale
  }
  if (unpriced.length > 0) return { kind: 'unpriced', models: unpriced }
  return { kind: 'priced', cost: { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output } }
}

/**
 * Currency amount with two decimals, or at most two significant digits below one cent.
 * @param amount - non-negative amount in the display currency.
 * @param currency - display currency choosing the symbol.
 * @param t - Chat locale seat.
 * @returns locale-owned amount text.
 */
export function formatCost(amount: number, currency: TokenPricing['costCurrency'], t: ChatViewSlotProps['t']): string {
  const digits = amount === 0 || amount >= 0.01
    ? amount.toFixed(2)
    : amount.toFixed(1 - Math.floor(Math.log10(amount))).replace(/0$/, '')
  return t(currency === 'USD' ? 'cost.usd' : 'cost.cny', { amount: digits })
}
