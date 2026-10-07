import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { decodeProductionState } from '../src/index.ts'
import type { ProductionState } from '../src/types.ts'

const binScript = fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/production.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('production Studio through the shipped Loader profile', () => {
  it('delivers bound binary files and durably captures the real graph with a keyless provider', async () => {
    let saved: ProductionState | undefined
    const result = await runLoaderSmoke({ label: 'production-studio', tempDirPrefix: 'production-loader-', binScript, libBinScript: binScript, configPath, binArgs: [configPath, 'prove production composition'], tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const document = JSON.parse(await readFile(join(cwd, '.state/production_studio.json'), 'utf8')) as { tables: { sessions: Record<string, unknown>; native: Record<string, unknown> } }
        const record = Object.values(document.tables.sessions)[0]
        saved = decodeProductionState(record)
        expect(document.tables.native).toEqual({})
      },
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('CLI tool round trip complete')
    expect(result.stdout).toContain('"type":"production_result"')
    const run = saved?.runs.at(-1)
    expect(run?.phase).toBe('complete')
    expect(run?.graph.version).toBe(2)
    expect(run?.tasks.find(task => task.nodeId === 'delivery')?.certificates.sort()).toEqual(['files', 'geometry', 'goal', 'manufacturing'])
    expect(run?.tasks.find(task => task.nodeId === 'file-check')?.evidence.some(item => item.toolName === 'production_aea_evidence')).toBe(true)
    if (!run) throw new Error('Loader did not persist its completed production run')
    const delivery = run.tasks.find(task => task.nodeId === 'delivery')
    const receipt = delivery?.evidence.findLast(item => item.toolName === 'production_aea_evidence' && typeof item.data === 'object' && item.data !== null && !Array.isArray(item.data) && item.data['fileReadbackVerified'] === true)?.data
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt) || !Array.isArray(receipt['files'])) throw new Error('Delivery lacks its actual file readback receipt')
    // Capture the compact delivery view without volatile IDs, paths or times;
    // the real verifier still binds the file bytes to their selected hashes.
    expect({
      phase: run.phase,
      tasks: run.graph.nodes.map(node => ({
        name: node.label, stage: node.kind, phase: run.tasks.find(task => task.nodeId === node.id)?.phase,
      })),
      verifiedEvidence: { geometry: receipt['geometryVerified'], manufacturing: receipt['manufacturingVerified'], files: receipt['fileReadbackVerified'], goal: receipt['goalSatisfied'] },
      files: receipt['files'].map((file) => {
        if (typeof file !== 'object' || file === null || Array.isArray(file) || typeof file['path'] !== 'string') throw new Error('Delivered file has no actual path')
        return { name: basename(file['path']), type: extname(file['path']).toLowerCase() }
      }),
    }).toMatchInlineSnapshot(`
      {
        "files": [
          {
            "name": "manufacturing.3dm",
            "type": ".3dm",
          },
          {
            "name": "laser.3dm",
            "type": ".3dm",
          },
        ],
        "phase": "complete",
        "tasks": [
          {
            "name": "基础方案",
            "phase": "complete",
            "stage": "program",
          },
          {
            "name": "几何检查",
            "phase": "complete",
            "stage": "gate",
          },
          {
            "name": "制造补偿与出图",
            "phase": "complete",
            "stage": "program",
          },
          {
            "name": "制造检查",
            "phase": "complete",
            "stage": "gate",
          },
          {
            "name": "保存文件检查",
            "phase": "complete",
            "stage": "gate",
          },
          {
            "name": "交付目标判定",
            "phase": "complete",
            "stage": "gate",
          },
          {
            "name": "交付",
            "phase": "complete",
            "stage": "delivery",
          },
          {
            "name": "修复或必要优化",
            "phase": "waiting",
            "stage": "program",
          },
        ],
        "verifiedEvidence": {
          "files": true,
          "geometry": true,
          "goal": true,
          "manufacturing": true,
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
