/** Estimated-cost row shared by the session and Turn usage dialogs. */

import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TokenPricing } from '../token-pricing.ts'
import { formatCost, type TokenCostEstimate } from './token-cost.ts'

/**
 * Render the estimated total, or name the billing models that have no configured price.
 * @param props - cost estimate, pricing for the currency symbol, and locale seat.
 * @returns a definition-list term and value pair.
 */
export function CostRow({ estimate, pricing, t }: {
  estimate: TokenCostEstimate
  pricing: TokenPricing
  t: ChatViewSlotProps['t']
}) {
  return (
    <>
      <dt>{t('cost.estimate')}</dt>
      <dd data-token-cost={estimate.kind}>
        {estimate.kind === 'priced'
          ? formatCost(estimate.cost.total, pricing.costCurrency, t)
          : t('cost.unpriced', { models: estimate.models.map(model => model === '' ? t('cost.unknownModel') : model).join(', ') })}
      </dd>
    </>
  )
}
