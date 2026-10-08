import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const bridgePath = process.env['DSH_TEST_EXTERNAL_AEA_PLUGIN']
const binScript = fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const seedPlugin = pathToFileURL(fileURLToPath(new URL('./fixtures/seed-external-bridge.ts', import.meta.url))).href
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('optional external AEA bridge source through the real Loader', () => {
  it.skipIf(!bridgePath).each([false, true])('registers compatibility/staged=%s without entering Rhino or native geometry', async (staged) => {
    if (!bridgePath) throw new Error('An explicitly selected external bridge source is required')
    const root = await mkdtemp(join(tmpdir(), 'production-external-bridge-'))
    try {
      const configPath = join(root, 'bridge.patch.yml')
      const instructions = join(root, 'test-role.md')
      await writeFile(instructions, 'External bridge registry and native boundary contract fixture. No native execution is authorized.')
      const mockPlugin = pathToFileURL(fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/cli-mock-llm.ts', import.meta.url))).href
      await writeFile(configPath, `- id: headless-startup\n  disabled: true\n- id: headless-runner\n  disabled: true\n- id: agent-loop\n  config:\n    agents:\n      []\n- id: storage-json\n  config:\n    root: './.state'\n- id: session-persistence-jsonl\n  config:\n    root: './.sessions'\n    compression: none\n- insert:\n    - id: cli-mock-llm\n      name: ${JSON.stringify(mockPlugin)}\n    - id: production-studio\n      name: '@deepseek-ai/dsh-production-studio'\n    - id: actual-aea-bridge\n      name: ${JSON.stringify(pathToFileURL(bridgePath).href)}\n      inject: [productionStudio]\n      config:\n        hostDll: './intentionally-unused.dll'\n        workspace: !!js process.cwd()\n        instructionsPath: ${JSON.stringify(instructions)}\n        maxCalls: 4\n        timeoutMs: 1000\n        stagedWorkflow: ${staged}\n    - id: observe-external-bridge\n      name: ${JSON.stringify(seedPlugin)}\n`)
      const result = await runLoaderSmoke({ label: `actual-aea-bridge-${staged}`, cwd: root, binScript, libBinScript: binScript, configPath, binArgs: [configPath, 'validate the selected bridge contract'], tsconfigPath: repoTsconfig, env: { DSH_LOADER_SMOKE_REQUIRED_ENTRY_ID: 'actual-aea-bridge' } })
      expect(result.stderr).toBe('')
      const observed = result.stdout.split('\n').find(line => line.includes('"type":"external_bridge_result"'))
      expect(observed).toBeDefined()
      expect(observed).toContain('"nativeDispatched":false')
      expect(observed).toContain(`"conversationProvider":${staged ? '"aea"' : 'null'}`)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
