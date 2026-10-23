/** Conversation run policy: presets and the logged chat request that applies one. */

/** How far the search continues after the verified baseline. */
export type PolicyDepth = 'baseline' | 'limited' | 'exhaustive'
/** Which candidates the manufacturing stage processes. */
export type PolicyManufacturing = 'best' | 'top'
/** Where improvement candidates come from. */
export type PolicySources = 'host' | 'model' | 'both'
/** Named starting points; `custom` marks a policy edited after choosing a preset. */
export type PolicyPreset = 'quick' | 'standard' | 'deep' | 'custom'

/**
 * User-chosen run policy. It reaches the model only as one ordinary chat message,
 * so the Host's frozen candidate limit and delivery gates still bound every case.
 */
export interface RunPolicy {
  preset: PolicyPreset
  depth: PolicyDepth
  /** Candidate count including the baseline when `depth` is `limited`. */
  candidates: number
  sources: PolicySources
  manufacturing: PolicyManufacturing
  /** Manufactured candidate count when `manufacturing` is `top`. */
  manufactureTop: number
  confirmDelivery: boolean
}

/** Smallest and largest candidate counts the Host accepts for a case. */
export const CANDIDATE_RANGE = { min: 2, max: 64 } as const
/** Largest manufactured candidate count offered by the form. */
export const MANUFACTURE_TOP_MAX = 8

/** Preset values; the form copies one and marks later edits `custom`. */
export const PRESETS: Readonly<Record<Exclude<PolicyPreset, 'custom'>, RunPolicy>> = {
  quick: { preset: 'quick', depth: 'baseline', candidates: 2, sources: 'both', manufacturing: 'best', manufactureTop: 2, confirmDelivery: false },
  standard: { preset: 'standard', depth: 'limited', candidates: 4, sources: 'both', manufacturing: 'best', manufactureTop: 2, confirmDelivery: false },
  deep: { preset: 'deep', depth: 'exhaustive', candidates: 8, sources: 'both', manufacturing: 'top', manufactureTop: 3, confirmDelivery: true },
}

/**
 * Clamp an entered count into an inclusive integer range.
 * @param value - entered number, possibly fractional or NaN.
 * @param min - smallest accepted count.
 * @param max - largest accepted count.
 * @returns the nearest integer inside the range.
 */
export function clampCount(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : min
}

/** Locale keys of the sentences composing a policy request. */
export type PolicySentenceKey =
  | 'policy.msg.intro' | 'policy.msg.depth.baseline' | 'policy.msg.depth.limited' | 'policy.msg.depth.exhaustive'
  | 'policy.msg.sources.host' | 'policy.msg.sources.model' | 'policy.msg.sources.both'
  | 'policy.msg.mfg.best' | 'policy.msg.mfg.top' | 'policy.msg.confirm' | 'policy.msg.noConfirm' | 'policy.msg.limits'

/**
 * Compose the chat request applying a policy to this conversation's current and later cases.
 * @param policy - chosen policy.
 * @param t - translator for the policy sentence keys.
 * @returns one message, a line per policy dimension.
 */
export function policyMessage(policy: RunPolicy, t: (key: PolicySentenceKey, values?: Record<string, number>) => string): string {
  return [
    t('policy.msg.intro'),
    `- ${t(`policy.msg.depth.${policy.depth}`, { candidates: policy.candidates })}`,
    ...policy.depth === 'baseline' ? [] : [`- ${t(`policy.msg.sources.${policy.sources}`)}`],
    `- ${t(`policy.msg.mfg.${policy.manufacturing}`, { top: policy.manufactureTop })}`,
    `- ${t(policy.confirmDelivery ? 'policy.msg.confirm' : 'policy.msg.noConfirm')}`,
    t('policy.msg.limits'),
  ].join('\n')
}
