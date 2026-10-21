import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { expect, it, onTestFinished } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { readAeaEvidence } from '../src/aea-evidence.ts'

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')
const parameters = 'a'.repeat(64)
const geometryCodes = ['source_decision_coverage', 'topology_binding', 'split_materialization', 'layout_overlap']

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'production-aea-evidence-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  onTestFinished(() => fiber.dispose())
  await mkdir(join(dir, 'reports'))
  const model = new Uint8Array([0, 255, 128, 3, 99, 0])
  const manufacturingModel = join(dir, 'manufacturing.3dm'), laserCutModel = join(dir, 'laser.3dm')
  await writeFile(manufacturingModel, model); await writeFile(laserCutModel, model)
  const checks = geometryCodes.map(code => ({ code, status: 'pass', message: '' }))
  const binding = { candidateId: 'candidate', inputVersion: 'input', runtimeParametersSha256: parameters }
  const search = { ...binding, reportId: 'search', stage: 'search', checks }
  const manufacturing = { ...binding, reportId: 'manufacturing', stage: 'manufacturing', manufacturingCompleted: true, reviewReady: true,
    checks: [...checks, { code: 'fold_angle_layout_current', status: 'pass', message: 'centered-on-bend-short-line-leader-v4' }, { code: 'face_material_preservation', status: 'pass', message: 'face-material-preservation-v3' }],
    costEvidence: { ...binding, reportId: 'manufacturing', status: 'known', threeComponentTotal: 24 },
    metrics: { manufacturing_piece_count: 1, weld_action_count: 3, bend_action_count: 4 },
    artifacts: { manufacturingModel, laserCutModel }, artifactSha256: { manufacturingModel: sha(model), laserCutModel: sha(model) } }
  const searchJson = JSON.stringify(search), manufacturingJson = JSON.stringify(manufacturing)
  await writeFile(join(dir, 'reports/search.json'), searchJson); await writeFile(join(dir, 'reports/manufacturing.json'), manufacturingJson)
  const caseFilePath = join(dir, 'case.json')
  await writeFile(caseFilePath, JSON.stringify({ caseId: 'case', inputVersion: 'input', input: { runtimeParametersSha256: parameters } }))
  const ledger = { caseId: 'case', inputVersion: 'input', revision: 8, pendingCandidateId: null, baselineCandidateId: 'candidate',
    attempts: [{ candidateId: 'candidate', status: 'verified', reportId: 'search', reportSha256: sha(searchJson) }],
    manufacturing: [{ candidateId: 'candidate', status: 'completed', reportId: 'manufacturing', reportSha256: sha(manufacturingJson) }] }
  const ledgerPath = join(dir, 'stage-workflow.json')
  await writeFile(ledgerPath, JSON.stringify(ledger))
  const receipt = {
    workflow: {
      caseId: 'case', inputVersion: 'input', revision: 8, manufacturingSelection: { deliveryReady: true },
      selectedDelivery: {
        status: 'known', candidateId: 'candidate', reportId: 'manufacturing', reportSha256: sha(manufacturingJson),
        artifacts: {
          manufacturingModel: { path: manufacturingModel, sha256: sha(model) },
          laserCutModel: { path: laserCutModel, sha256: sha(model) },
        },
      },
    },
  }
  const args = { caseId: 'case', caseFilePath, stage: 'goal', receipt, deliveryGoal: { kind: 'verified-drawings' } }
  const read = (input: JsonValue = args) => readAeaEvidence(ctx.fs, input, new AbortController().signal, 1024 * 1024)
  return { read, args, model, manufacturingModel, laserCutModel, ledger, ledgerPath, manufacturing, dir }
}

it('reads both binary outputs and verifies frozen identities without invoking native work', async () => {
  const f = await fixture()
  const result = await f.read()
  expect(result).toMatchObject({ geometryVerified: true, manufacturingVerified: true, fileReadbackVerified: true, goalSatisfied: true,
    files: [{ path: f.manufacturingModel, sha256: sha(f.model), bytes: 6 }, { path: f.laserCutModel, sha256: sha(f.model), bytes: 6 }] })
})

it('rejects altered saved geometry and stale report receipts', async () => {
  const f = await fixture()
  await writeFile(f.laserCutModel, new Uint8Array([1, 2, 3]))
  expect(await f.read()).toMatchObject({ fileReadbackVerified: false, goalSatisfied: false })
  await writeFile(f.laserCutModel, f.model)
  f.args.receipt.workflow.revision = 7
  expect(await f.read()).toMatchObject({ manufacturingVerified: false, goalSatisfied: false })
})

it('keeps unknown native outcomes blocked and never marks a natural-language goal complete', async () => {
  const f = await fixture()
  f.ledger.manufacturing[0]!.status = 'unknown'
  await writeFile(f.ledgerPath, JSON.stringify(f.ledger))
  expect(await f.read()).toMatchObject({ manufacturingVerified: false, goalSatisfied: false })
  f.ledger.manufacturing[0]!.status = 'completed'
  await writeFile(f.ledgerPath, JSON.stringify(f.ledger))
  expect(await f.read({ ...f.args, deliveryGoal: 'make it cheaper' })).toMatchObject({ goalSatisfied: false })
})

it('evaluates explicit goal thresholds against actual manufacturing metrics', async () => {
  const f = await fixture()
  expect(await f.read({ ...f.args, deliveryGoal: { kind: 'verified-drawings', maxManufacturingScore: 23 } })).toMatchObject({ fileReadbackVerified: true, goalSatisfied: false })
  expect(await f.read({ ...f.args, deliveryGoal: { kind: 'verified-drawings', maxManufacturingScore: 24, maxPieces: 1 } })).toMatchObject({ goalSatisfied: true })
})

it('requires exact current drawing versions and retained report hashes', async () => {
  const f = await fixture()
  f.manufacturing.checks[4]!.message = 'centered-on-bend-glyph-envelope-v3'
  const bytes = JSON.stringify(f.manufacturing)
  await writeFile(join(f.dir, 'reports/manufacturing.json'), bytes)
  f.ledger.manufacturing[0]!.reportSha256 = sha(bytes)
  f.args.receipt.workflow.selectedDelivery.reportSha256 = sha(bytes)
  await writeFile(f.ledgerPath, JSON.stringify(f.ledger))
  expect(await f.read()).toMatchObject({ manufacturingVerified: false, goalSatisfied: false })
})

it('judges geometry on the Host baseline, not a later failed exploratory attempt', async () => {
  const f = await fixture()
  const failed = { candidateId: 'explored', inputVersion: 'input', runtimeParametersSha256: parameters, reportId: 'explored', stage: 'search',
    checks: [...geometryCodes.map(code => ({ code, status: 'pass', message: '' })), { code: 'geometry_error', status: 'fail', message: 'skip_side_unresolved' }] }
  const failedJson = JSON.stringify(failed)
  await writeFile(join(f.dir, 'reports/explored.json'), failedJson)
  const attempts = [...f.ledger.attempts, { candidateId: 'explored', status: 'verified', reportId: 'explored', reportSha256: sha(failedJson) }]
  await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, attempts }))
  expect(await f.read({ ...f.args, stage: 'geometry' })).toMatchObject({ geometryVerified: true, geometryCandidateId: 'candidate' })
  await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, attempts, baselineCandidateId: 'explored' }))
  expect(await f.read({ ...f.args, stage: 'geometry' })).toMatchObject({ geometryVerified: false, geometryCandidateId: 'explored' })
  await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, attempts, baselineCandidateId: 'missing' }))
  expect(await f.read({ ...f.args, stage: 'geometry' })).toMatchObject({ geometryVerified: false, reasons: ['AEA baseline candidate has no unique verified search report'] })
  await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, attempts, baselineCandidateId: null }))
  expect(await f.read({ ...f.args, stage: 'geometry' })).toMatchObject({ geometryVerified: false, reasons: ['Missing exact evidence identity'] })
})
