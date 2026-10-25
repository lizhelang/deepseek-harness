import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  Config, apply,
} from '../src/index.ts'
import { DEFAULT_MODEL_PRICES } from '../src/chat-settings.ts'


describe('ui-chat Host settings', () => {
  it('registers, validates, and disposes the transcript-view namespace', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration

    const defaults = {
      performanceUsage: 'detailed', linkOpening: 'sidebar', collapseTiming: 'completion',
      costCurrency: 'CNY', cnyPerUsd: 7.1, modelPrices: DEFAULT_MODEL_PRICES,
    }
    expect(plainConfig(configuration.fiber.config)).toEqual(defaults)
    await configuration.update({ transcriptView: 'normal' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ transcriptView: 'normal', ...defaults })
    for (const mode of ['expanded', 'compact', 'standard', 'detailed', 'verbose']) {
      await configuration.update({ transcriptView: mode })
      expect(plainConfig(configuration.fiber.config)).toMatchObject({ transcriptView: mode })
    }
    for (const mode of ['dense', '', 42, false, {}, null, undefined]) {
      await configuration.update({ transcriptView: mode })
      expect(plainConfig(configuration.fiber.config)).toMatchObject({ transcriptView: mode === null ? null : undefined })
    }
    await configuration.update({ performanceUsage: 'compact' })
    expect(plainConfig(configuration.fiber.config)).toMatchObject({ performanceUsage: 'compact' })
    await expect(configuration.update({ performanceUsage: 'hidden' })).rejects.toThrow()
    await configuration.update({ linkOpening: 'new-tab' })
    expect(plainConfig(configuration.fiber.config)).toMatchObject({ linkOpening: 'new-tab' })
    await expect(configuration.update({ linkOpening: 'popup' })).rejects.toThrow()
    const prices = [{ model: 'deepseek-chat', cacheHit: 0.5, input: 2, output: 8 }]
    await configuration.update({ costCurrency: 'USD', cnyPerUsd: 7.2, modelPrices: prices })
    expect(plainConfig(configuration.fiber.config)).toMatchObject({ costCurrency: 'USD', cnyPerUsd: 7.2, modelPrices: prices })
    await expect(configuration.update({ costCurrency: 'EUR' })).rejects.toThrow()
    await expect(configuration.update({ cnyPerUsd: -1 })).rejects.toThrow()
    await expect(configuration.update({ modelPrices: [{ model: 'x', cacheHit: -1, input: 0, output: 0 }] })).rejects.toThrow()

    await fiber.dispose()
  })

  it('validates collapse timing and restores its saved config independently of work details', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    expect(plainConfig(configuration.fiber.config)).toMatchObject({ collapseTiming: 'completion' })
    await configuration.update({ transcriptView: 'compact', collapseTiming: 'next-input' })
    const saved = plainConfig(configuration.fiber.config)
    if (typeof saved !== 'object' || saved === null) throw new Error('expected saved configuration object')
    expect(saved).toMatchObject({ transcriptView: 'compact', collapseTiming: 'next-input' })
    await expect(configuration.update({ collapseTiming: 'never' })).rejects.toThrow()
    await configuration.fiber.dispose()
    const restored = await liveConfig(ctx, { Config, apply }, saved)
    expect(plainConfig(restored.fiber.config)).toMatchObject({ transcriptView: 'compact', collapseTiming: 'next-input' })
    await restored.fiber.dispose()
  })

  it('loads without a settings provider', async () => {
    const ctx = new Context()
    await expect(ctx.plugin({ Config, apply }).await()).resolves.toBeDefined()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
