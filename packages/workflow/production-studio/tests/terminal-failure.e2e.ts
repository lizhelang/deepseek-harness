import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { decodeProductionState } from '../src/index.ts'

const binScript = fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/terminal-failure.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('capability failure through the shipped Loader', () => {
  it('persists the known failure and refuses another model tool call without activating repair or requesting a choice', async () => {
    const result = await runLoaderSmoke({ label: 'terminal-failure', tempDirPrefix: 'terminal-failure-loader-', binScript, libBinScript: binScript,
      configPath, binArgs: [configPath, 'Complete this same case within its existing budget'], tsconfigPath,
      inspect: async (cwd) => {
        const document = JSON.parse(await readFile(join(cwd, '.state/production_studio.json'), 'utf8')) as { tables: { sessions: Record<string, unknown> } }
        const run = decodeProductionState(Object.values(document.tables.sessions)[0]).runs[0]!
        expect(run.phase).toBe('blocked'); expect(run.executions).toBe(1)
        expect(run.tasks[0]?.settledOperationId).toBe('terminal-call-0')
        expect(run.tasks[0]?.output).toMatchObject({ workflow: {
          control: { status: 'capability_blocked', terminal: true, reasonCode: 'no_executable_next_action', nextActions: [] },
          continuationPolicy: { userChoiceRequired: false },
        } })
        expect(run.tasks[0]?.evidence.at(-1)?.data).toEqual(run.tasks[0]?.output)
        expect(run.tasks.some(task => ['running', 'ready', 'human'].includes(task.phase))).toBe(false)
      },
    })
    expect(result.stderr).toBe('')
    const line = result.stdout.split('\n').find(item => item.includes('"type":"terminal_failure_result"'))
    expect(JSON.parse(line!)).toEqual({ type: 'terminal_failure_result', calls: 1, phase: 'blocked', taskPhase: 'blocked',
      executions: 1, humanWait: false, repairPhase: 'waiting' })
    expect(result.stdout).toContain('开发侧能力受阻：no_executable_next_action；不要求用户二选一。')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
