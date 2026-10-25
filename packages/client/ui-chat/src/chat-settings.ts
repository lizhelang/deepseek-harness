/** Chat display preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the Chat target. */
export const CHAT_SETTINGS_NAMESPACE = 'ui-chat'

/** Field carrying the work-details presentation mode. */
export const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/** Field carrying the independent work-details collapse timing. */
export const COLLAPSE_TIMING_FIELD = 'collapseTiming'

/** Available points when a completed Turn returns to its historical presentation. */
export const COLLAPSE_TIMINGS = ['completion', 'next-input'] as const

/** When a completed Turn returns to its historical presentation. */
export type CollapseTiming = typeof COLLAPSE_TIMINGS[number]

/** Preserve completion-time folding when no timing preference is saved. */
export const DEFAULT_COLLAPSE_TIMING: CollapseTiming = 'completion'

/** Work-details presentation modes a user can choose. */
export const TRANSCRIPT_VIEW_MODES = ['compact', 'standard', 'detailed', 'verbose'] as const

/** Work-details presentation mode. */
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]

/**
 * Saved value from the two-mode generation of this setting. Read as `detailed`;
 * never offered as a choice and never written back.
 */
export const LEGACY_TRANSCRIPT_VIEW_MODE = 'normal'

/** Saved `expanded` values read as `detailed`, without being offered or written back. */
export const LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE = 'expanded'

/** Every value the durable field accepts: current modes plus legacy saved values. */
const TRANSCRIPT_VIEW_SETTING_VALUES = [
  ...TRANSCRIPT_VIEW_MODES, LEGACY_TRANSCRIPT_VIEW_MODE, LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE,
] as const

/** Default work details for non-Desktop Web clients. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'detailed'

/** Performance and usage detail levels accepted by user settings. */
export const PERFORMANCE_USAGE_MODES = ['compact', 'detailed'] as const

/** Performance and usage presentation. */
export type PerformanceUsageMode = typeof PERFORMANCE_USAGE_MODES[number]

/** Preserve detailed accounting for users without an explicit preference. */
export const DEFAULT_PERFORMANCE_USAGE: PerformanceUsageMode = 'detailed'

/** Destinations for ordinary clicks on Chat HTTP(S) links. */
export type LinkOpening = 'sidebar' | 'new-tab'

/** Preserve the built-in browser for users without an explicit preference. */
export const DEFAULT_LINK_OPENING: LinkOpening = 'sidebar'

/** Currencies the usage displays can show an estimated cost in. */
export const COST_CURRENCIES = ['CNY', 'USD'] as const

/** Display currency for estimated cost. */
export type CostCurrency = typeof COST_CURRENCIES[number]

/** Show cost in the currency DeepSeek bills in unless the user chooses otherwise. */
export const DEFAULT_COST_CURRENCY: CostCurrency = 'CNY'

/** Yuan per US dollar used to convert the yuan prices for USD display. */
export const DEFAULT_CNY_PER_USD = 7.1

/** Yuan price per million tokens of one model's billing buckets. */
export interface ModelTokenPrice {
  /** Provider-owned model id the price applies to, matched exactly. */
  model: string
  /** Cached (cache-hit) prompt input. */
  cacheHit: number
  /** Uncached prompt input; cache writes are charged at this rate too. */
  input: number
  /** Output, including reasoning. */
  output: number
}

/** DeepSeek's published peak-hour prices, effective 2026-08-17. */
export const DEFAULT_MODEL_PRICES: readonly ModelTokenPrice[] = [
  { model: 'deepseek-flash', cacheHit: 0.1, input: 3, output: 9 },
  { model: 'deepseek-v4-pro', cacheHit: 0.3, input: 9, output: 27 },
]

/** Durable Chat section shared by the Host schema and browser scope. */
export interface ChatSettings {
  /** Work-details preference; absence uses the client default, and legacy saved values remain accepted. */
  transcriptView?: TranscriptViewMode | typeof LEGACY_TRANSCRIPT_VIEW_MODE | typeof LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE | null
  /** Independent collapse timing; absence preserves completion-time folding. */
  collapseTiming?: CollapseTiming
  /** Detail level for composer statistics and completed-Turn usage. */
  performanceUsage: PerformanceUsageMode
  /** Default destination for Chat HTTP(S) links. */
  linkOpening: LinkOpening
  /** Currency of the estimated cost shown beside token usage. */
  costCurrency: CostCurrency
  /** Yuan per US dollar for USD display. */
  cnyPerUsd: number
  /** Yuan prices per million tokens; a model without an entry shows no cost. */
  modelPrices: ModelTokenPrice[]
}

/** Durable Chat schema; also the wire envelope the browser scope validates against. */
export const ChatSettingsFields = {
  [COLLAPSE_TIMING_FIELD]: z.union([...COLLAPSE_TIMINGS]).default(DEFAULT_COLLAPSE_TIMING),
  linkOpening: z.union(['sidebar', 'new-tab']).default(DEFAULT_LINK_OPENING),
  performanceUsage: z.union([...PERFORMANCE_USAGE_MODES]).default(DEFAULT_PERFORMANCE_USAGE),
  costCurrency: z.union([...COST_CURRENCIES]).default(DEFAULT_COST_CURRENCY),
  cnyPerUsd: z.number().min(0).default(DEFAULT_CNY_PER_USD),
  modelPrices: z.array(z.object({
    model: z.string().required(),
    cacheHit: z.number().min(0).required(),
    input: z.number().min(0).required(),
    output: z.number().min(0).required(),
  })).default(DEFAULT_MODEL_PRICES.map(price => ({ ...price }))),
  // Missing and unrecognized modes defer to the client's default.
  [TRANSCRIPT_VIEW_FIELD]: z.union([...TRANSCRIPT_VIEW_SETTING_VALUES]).loose(),
}

/** Schema for shared configuration values. */
export const ChatSettingsSchema = z.object(ChatSettingsFields)
