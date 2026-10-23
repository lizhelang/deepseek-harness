/** Run policy form for conversation-mode Sessions. */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { StudioViewProps } from './slots.ts'
import { caseRuns } from './CasePanel.tsx'
import { CANDIDATE_RANGE, clampCount, MANUFACTURE_TOP_MAX, PRESETS, policyMessage, type RunPolicy } from './run-policy.ts'
import css from './RunPolicy.module.css'

type Translate = PropsLocale<'productionStudio'>['t']

function Choices<Value extends string>({ legend, value, options, label, onChange, children }: {
  legend: string
  value: Value
  options: readonly Value[]
  label: (value: Value) => string
  onChange: (value: Value) => void
  children?: ReactNode
}) {
  return <fieldset className={css.group}>
    <legend>{legend}</legend>
    <div className={css.choices}>
      {options.map(option => <Button key={option} size="sm" variant={option === value ? 'primary' : 'outline'} aria-pressed={option === value}
        onClick={() => { onChange(option) }}>{label(option)}</Button>)}
      {children}
    </div>
  </fieldset>
}

function Count({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  return <label className={css.count}>{label}
    <Input type="number" min={CANDIDATE_RANGE.min} max={max} aria-label={label} value={value}
      onChange={(event) => { onChange(clampCount(Number(event.target.value), CANDIDATE_RANGE.min, max)) }} /></label>
}

/**
 * Edit a run policy and queue it as one chat request.
 * @param props - current policy, frozen case limit, locale seat and callbacks.
 * @returns the policy form.
 */
export function RunPolicyForm({ policy, caseLimit, t, onChange, send }: {
  policy: RunPolicy
  caseLimit: number | undefined
  t: Translate
  onChange: (policy: RunPolicy) => void
  send: (text: string) => Promise<string | null>
}) {
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null)
  const edit = (change: Partial<RunPolicy>): void => { onChange({ ...policy, ...change, preset: 'custom' }); setStatus(null) }
  const message = policyMessage(policy, t)
  const apply = (): void => {
    setPending(true); setStatus(null)
    void send(message).then((error) => {
      setStatus(error === null ? { error: false, text: t('policy.applied') } : { error: true, text: `${t('action.failed')}: ${error}` })
    }).finally(() => { setPending(false) })
  }
  return <section className={css.policy} data-production-policy={policy.preset}>
    <h2>{t('policy.title')}</h2>
    <p className={css.muted}>{t('policy.intro')}</p>
    <div className={css.presets}>
      {(['quick', 'standard', 'deep'] as const).map(preset => <button key={preset} type="button" className={css.preset}
        aria-pressed={policy.preset === preset} data-policy-preset={preset}
        onClick={() => { onChange({ ...PRESETS[preset] }); setStatus(null) }}>
        <strong>{t(`policy.preset.${preset}`)}</strong>
        <span className={css.muted}>{t(`policy.preset.${preset}.detail`)}</span>
      </button>)}
    </div>
    {policy.preset === 'custom' && <p className={css.muted}>{t('policy.custom')}</p>}
    <Choices legend={t('policy.depth')} value={policy.depth} options={['baseline', 'limited', 'exhaustive'] as const}
      label={value => t(`policy.depth.${value}`)} onChange={(depth) => { edit({ depth }) }}>
      {policy.depth === 'limited' && <Count label={t('policy.candidates')} value={policy.candidates} max={CANDIDATE_RANGE.max}
        onChange={(candidates) => { edit({ candidates }) }} />}
    </Choices>
    {caseLimit !== undefined && <p className={css.muted}>{t('policy.caseLimit', { limit: caseLimit })}</p>}
    {policy.depth !== 'baseline' && <Choices legend={t('policy.sources')} value={policy.sources} options={['both', 'host', 'model'] as const}
      label={value => t(`policy.sources.${value}`)} onChange={(sources) => { edit({ sources }) }} />}
    <Choices legend={t('policy.manufacturing')} value={policy.manufacturing} options={['best', 'top'] as const}
      label={value => t(`policy.mfg.${value}`)} onChange={(manufacturing) => { edit({ manufacturing }) }}>
      {policy.manufacturing === 'top' && <Count label={t('policy.manufactureTop')} value={policy.manufactureTop} max={MANUFACTURE_TOP_MAX}
        onChange={(manufactureTop) => { edit({ manufactureTop }) }} />}
    </Choices>
    <fieldset className={css.group}>
      <legend>{t('policy.checkpoints')}</legend>
      <Checkbox label={t('policy.confirmDelivery')} checked={policy.confirmDelivery} onChange={(confirmDelivery) => { edit({ confirmDelivery }) }} />
    </fieldset>
    <fieldset className={css.group}>
      <legend>{t('policy.cost')}</legend>
      <p className={css.muted}>{t('policy.costFormula')}</p>
    </fieldset>
    <details className={css.preview}><summary>{t('policy.preview')}</summary><pre data-policy-message>{message}</pre></details>
    <div className={css.apply}>
      <Button size="sm" variant="primary" disabled={pending} onClick={apply}>{pending ? t('action.pending') : t('policy.apply')}</Button>
      {status !== null && <span className={status.error ? css.error : css.muted} role="status">{status.text}</span>}
    </div>
  </section>
}

/**
 * Show the run policy form for Sessions with a conversation adapter.
 * @param props - Studio view props.
 * @returns the form, or the loading, unavailable or no-adapter state.
 */
export function ProductionPolicyView(props: StudioViewProps) {
  const { useProduction, useStore, actions, t, send, refresh } = props
  const read = useProduction(value => value)
  const policy = useStore(value => value.policy)
  const snapshot = read.snapshot
  if (snapshot === null) return <div className={css.policy}><p className={css.muted}>{read.loading ? t('loading') : read.error ?? t('unavailable')}</p>
    {!read.loading && <Button size="sm" onClick={refresh}>{t('refresh')}</Button>}</div>
  if (snapshot.capabilities.conversation === undefined) return <div className={css.policy}><p className={css.muted}>{t('policy.noAdapter')}</p></div>
  const caseLimit = caseRuns(snapshot.runs)[0]?.case.candidates.limit
  return <RunPolicyForm policy={policy} caseLimit={caseLimit} t={t} onChange={actions.policy} send={send} />
}
