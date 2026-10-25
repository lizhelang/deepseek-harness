/** General Settings row for cost-estimate currency, exchange rate, and per-model token prices. */

import { useEffect, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutlineRegular, IconTrashOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_MODEL_PRICES, type CostCurrency, type ModelTokenPrice } from '../../chat-settings.ts'
import type { TokenPricing } from '../token-pricing.ts'
import { PreferenceRow } from './PreferenceRow.tsx'
import css from './TokenPricingRow.module.css'

/** Registration-side token-pricing preference face. */
export interface TokenPricingRowInjected {
  hooks: {
    /** Accepted token prices and display currency, bound as useTokenPricing. */
    tokenPricing: ObservableSnapshot<TokenPricing>
  }
  /** Change one pricing field. */
  setTokenPricing: <K extends keyof TokenPricing>(field: K, value: TokenPricing[K]) => void
}

/** Full Settings-row props. */
export type TokenPricingRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<TokenPricingRowInjected>

type PriceField = Exclude<keyof ModelTokenPrice, 'model'>

const PRICE_FIELDS: readonly PriceField[] = ['cacheHit', 'input', 'output']

/**
 * Text input that keeps its draft locally and commits on blur or Enter; a
 * draft the parser rejects reverts to the committed value.
 */
function DraftField<T extends string | number>({ value, parse, onCommit, label, className }: {
  value: string
  parse: (draft: string) => T | undefined
  onCommit: (value: T) => void
  label: string
  className?: string | undefined
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => {
    const parsed = parse(draft.trim())
    if (parsed === undefined || String(parsed) === value) setDraft(value)
    else onCommit(parsed)
  }
  return (
    <Input
      className={className ?? ''}
      aria-label={label}
      value={draft}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    />
  )
}

const parsePrice = (draft: string): number | undefined => {
  const value = Number(draft)
  return draft !== '' && Number.isFinite(value) && value >= 0 ? value : undefined
}

const parseRate = (draft: string): number | undefined => {
  const value = parsePrice(draft)
  return value === undefined || value === 0 ? undefined : value
}

const parseModel = (draft: string): string | undefined => draft === '' ? undefined : draft

/**
 * Render the currency selector, the USD exchange rate, and the editable price table.
 * @param props - composed Settings slot props.
 * @returns the settings block.
 */
export function TokenPricingRow({ useTokenPricing, setTokenPricing, t }: TokenPricingRowProps) {
  const pricing = useTokenPricing(value => value)
  const prices = pricing.modelPrices
  const replacePrices = (next: readonly ModelTokenPrice[]) => { setTokenPricing('modelPrices', next) }
  const updatePrice = (index: number, patch: Partial<ModelTokenPrice>) => {
    replacePrices(prices.map((price, position) => position === index ? { ...price, ...patch } : price))
  }
  const fieldLabels: Record<PriceField, string> = {
    cacheHit: t('settings.pricing.cacheHit'),
    input: t('settings.pricing.input'),
    output: t('settings.pricing.output'),
  }
  return (
    <div className={css.root} data-token-pricing>
      <PreferenceRow
        title={t('settings.pricing.title')}
        description={t('settings.pricing.description')}
        value={pricing.costCurrency}
        selectedLabel={t(pricing.costCurrency === 'USD' ? 'settings.pricing.usd' : 'settings.pricing.cny')}
        options={[
          { id: 'CNY', label: t('settings.pricing.cny') },
          { id: 'USD', label: t('settings.pricing.usd') },
        ]}
        onSelect={(value) => { setTokenPricing('costCurrency', value as CostCurrency) }}
      />
      {pricing.costCurrency === 'USD' && (
        <label className={css.rate}>
          <span>{t('settings.pricing.rate')}</span>
          <DraftField
            className={css.rateField}
            label={t('settings.pricing.rate')}
            value={String(pricing.cnyPerUsd)}
            parse={parseRate}
            onCommit={(value) => { setTokenPricing('cnyPerUsd', value) }}
          />
        </label>
      )}
      <div className={css.table} role="table" aria-label={t('settings.pricing.tableLabel')}>
        <div className={css.headRow} role="row">
          <span role="columnheader">{t('settings.pricing.model')}</span>
          {PRICE_FIELDS.map(field => <span key={field} role="columnheader">{fieldLabels[field]}</span>)}
          <span aria-hidden />
        </div>
        {prices.map((price, index) => (
          <div key={index} className={css.row} role="row">
            <DraftField
              label={t('settings.pricing.model')}
              value={price.model}
              parse={parseModel}
              onCommit={(model) => { updatePrice(index, { model }) }}
            />
            {PRICE_FIELDS.map(field => (
              <DraftField
                key={field}
                label={`${price.model} ${fieldLabels[field]}`}
                value={String(price[field])}
                parse={parsePrice}
                onCommit={(value) => { updatePrice(index, { [field]: value }) }}
              />
            ))}
            <Button
              size="sm"
              aria-label={t('settings.pricing.remove', { model: price.model })}
              icon={<IconTrashOutlineRegular />}
              onClick={() => { replacePrices(prices.filter((_price, position) => position !== index)) }}
            />
          </div>
        ))}
      </div>
      <div className={css.actions}>
        <Button
          size="sm"
          icon={<IconPlusOutlineRegular />}
          onClick={() => { replacePrices([...prices, { model: t('settings.pricing.newModel'), cacheHit: 0, input: 0, output: 0 }]) }}
        >
          {t('settings.pricing.add')}
        </Button>
        <Button size="sm" onClick={() => { replacePrices(DEFAULT_MODEL_PRICES) }}>
          {t('settings.pricing.reset')}
        </Button>
      </div>
    </div>
  )
}
