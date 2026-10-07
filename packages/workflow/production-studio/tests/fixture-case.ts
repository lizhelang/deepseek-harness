/** External native-provider fixtures; the production verifier still reads real bytes. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/**
 * Write bound external-provider reports and binary artifacts.
 * @param root - owned fixture directory.
 * @param failed - whether geometry is rejected.
 * @returns source input, actual Host-style receipt and binary hash.
 */
export async function writeFixtureCase(root: string, failed = false): Promise<{
  input: { caseId: string; caseFilePath: string; filePath: string; sha256: string }
  receipt: JsonValue
}> {
  await mkdir(join(root, 'reports'), { recursive: true })
  const bytes = Uint8Array.from([0, 255, 128, 3, 99, 0])
  const manufacturingModel = join(root, 'manufacturing.3dm'), laserCutModel = join(root, 'laser.3dm')
  await writeFile(manufacturingModel, bytes)
  await writeFile(laserCutModel, bytes)
  const parameters = 'a'.repeat(64)
  const checks = ['source_decision_coverage', 'topology_binding', 'split_materialization', 'layout_overlap'].map(code => ({ code, status: failed && code === 'layout_overlap' ? 'fail' : 'pass', message: '' }))
  const binding = { candidateId: 'candidate', inputVersion: 'input', runtimeParametersSha256: parameters }
  const search = JSON.stringify({ ...binding, reportId: 'search', stage: 'search', checks })
  const manufactured = JSON.stringify({ ...binding, reportId: 'manufacturing', stage: 'manufacturing', manufacturingCompleted: true, reviewReady: true,
    checks: [...checks, { code: 'fold_angle_layout_current', status: 'pass', message: 'centered-on-bend-glyph-envelope-v3' }, { code: 'face_material_preservation', status: 'pass', message: 'face-material-preservation-v3' }],
    costEvidence: { ...binding, reportId: 'manufacturing', status: 'known', threeComponentTotal: 24 }, metrics: { manufacturing_piece_count: 1, weld_action_count: 3, bend_action_count: 4 },
    artifacts: { manufacturingModel, laserCutModel }, artifactSha256: { manufacturingModel: sha(bytes), laserCutModel: sha(bytes) },
  })
  await writeFile(join(root, 'reports/search.json'), search)
  await writeFile(join(root, 'reports/manufacturing.json'), manufactured)
  const caseFilePath = join(root, 'case.json')
  await writeFile(caseFilePath, JSON.stringify({ caseId: 'case', inputVersion: 'input', input: { runtimeParametersSha256: parameters } }))
  await writeFile(join(root, 'stage-workflow.json'), JSON.stringify({ caseId: 'case', inputVersion: 'input', revision: 8, pendingCandidateId: null,
    attempts: [{ candidateId: 'candidate', status: 'verified', reportId: 'search', reportSha256: sha(search) }],
    manufacturing: [{ candidateId: 'candidate', status: 'completed', reportId: 'manufacturing', reportSha256: sha(manufactured) }],
  }))
  const receipt = { workflow: { caseId: 'case', inputVersion: 'input', revision: 8, manufacturingSelection: { deliveryReady: true }, selectedDelivery: { status: 'known', candidateId: 'candidate', reportId: 'manufacturing', reportSha256: sha(manufactured), artifacts: { manufacturingModel: { path: manufacturingModel, sha256: sha(bytes) }, laserCutModel: { path: laserCutModel, sha256: sha(bytes) } } } } }
  return { input: { caseId: 'case', caseFilePath, filePath: manufacturingModel, sha256: sha(bytes) }, receipt }
}
