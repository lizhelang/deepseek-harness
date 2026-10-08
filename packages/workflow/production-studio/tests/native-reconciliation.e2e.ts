import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { decodeProductionState } from '../src/index.ts'

const binScript = fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/native-reconciliation.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
describe('native reconciliation through the shipped Loader', () => {
  it('records the real error call, automatically settles trusted rejection and continues the same conversation without replay', async () => {
    const result = await runLoaderSmoke({ label: 'native-reconciliation', tempDirPrefix: 'native-reconciliation-loader-', binScript, libBinScript: binScript,
      configPath, binArgs: [configPath, 'Inspect the existing suggestion'], tsconfigPath,
      inspect: async (cwd) => {
        const document = JSON.parse(await readFile(join(cwd, '.state/production_studio.json'), 'utf8')) as { tables: { sessions: Record<string, unknown>; native: Record<string, unknown> } }
        expect(document.tables.native).toEqual({})
        const run = decodeProductionState(Object.values(document.tables.sessions)[0]).runs[0]!
        expect(run.tasks[0]?.settledOperationId).toBe('loader-native-call')
        expect(run.tasks[0]?.evidence.at(-1)?.data).toMatchObject({ nativeReconciliation: { result: { outcome: 'rejected_before_native' } } })
        expect(run.executions).toBe(1); expect(run.tasks[0]?.attempts).toBe(1)
      },
    })
    expect(result.stderr).toBe('')
    const line = result.stdout.split('\n').find(item => item.includes('"type":"native_reconciliation_result"'))
    expect(JSON.parse(line!)).toMatchInlineSnapshot(`
      {
        "attempts": 1,
        "calls": 1,
        "certificates": [],
        "executions": 1,
        "otherSessionPresent": true,
        "phase": "active",
        "quarantine": false,
        "reconciliations": 1,
        "taskPhase": "running",
        "type": "native_reconciliation_result",
      }
    `)
    expect(result.stdout).toContain('Original rejection retained; no replay.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
