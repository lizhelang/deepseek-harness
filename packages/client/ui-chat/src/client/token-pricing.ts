/** Token-price preference shared by the Settings row and the usage displays. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_CNY_PER_USD, DEFAULT_COST_CURRENCY, DEFAULT_MODEL_PRICES,
  type ChatSettings, type ModelTokenPrice,
} from '../chat-settings.ts'

/** Everything a usage display needs to estimate cost: the Chat settings' pricing fields. */
export type TokenPricing = Readonly<Pick<ChatSettings, 'costCurrency' | 'cnyPerUsd'>> & {
  readonly modelPrices: readonly ModelTokenPrice[]
}

/** Pricing for users without an explicit preference. */
export const DEFAULT_TOKEN_PRICING: TokenPricing = {
  costCurrency: DEFAULT_COST_CURRENCY,
  cnyPerUsd: DEFAULT_CNY_PER_USD,
  modelPrices: DEFAULT_MODEL_PRICES,
}

/** Live pricing preference, reconciled with accepted Host settings when available. */
export class TokenPricingPolicy {
  private readonly unsubscribe: () => void
  /** Current pricing; defaults until the Host section is accepted. */
  readonly pricing = createSnapshotStore<TokenPricing>(DEFAULT_TOKEN_PRICING)

  /** @param host - Chat settings scope, durable on loopback and memory-only elsewhere. */
  constructor(private readonly host: ConfigForm<ChatSettings>) {
    const adopt = (): void => {
      const accepted = host.getSnapshot().value
      if (accepted === undefined) return
      this.pricing.set({
        costCurrency: accepted.costCurrency,
        cnyPerUsd: accepted.cnyPerUsd,
        modelPrices: accepted.modelPrices,
      })
    }
    this.unsubscribe = host.subscribe(adopt)
    adopt()
  }

  /** Release the accepted-value subscription. */
  dispose(): void { this.unsubscribe() }

  /**
   * Publish one pricing field immediately and persist it when the scope supports writes.
   * @param field - pricing field to change.
   * @param value - new value selected by the user.
   */
  set<K extends keyof TokenPricing>(field: K, value: TokenPricing[K]): void {
    this.pricing.set({ ...this.pricing.getSnapshot(), [field]: value })
    void this.host.set(field, value).catch((_error: unknown) => {
      // The local choice remains usable when persistence is unavailable.
    })
  }
}
