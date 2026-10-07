/** Read-only AEA evidence adapter. It never resumes a workflow or invokes Rhino. */
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

type RecordValue = { [key: string]: JsonValue }
function record(value: JsonValue | undefined): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an evidence object')
  return value
}
function list(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : [] }
function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing exact evidence identity')
  return value
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function same(actual: JsonValue | undefined, expected: JsonValue | undefined, label: string): void {
  if (expected === undefined || actual !== expected) throw new Error(`AEA evidence binding mismatch: ${label}`)
}
function check(report: RecordValue, code: string, version?: string): boolean {
  const matches = list(report.checks).map(record).filter(item => item.code === code)
  return matches.length === 1 && matches[0]?.status === 'pass'
    && (version === undefined || (typeof matches[0].message === 'string' && new RegExp(`(?<![A-Za-z0-9_-])${version}(?![A-Za-z0-9_-])`).test(matches[0].message)))
}
function geometry(report: RecordValue): boolean {
  return !list(report.checks).map(record).some(item => item.status === 'fail')
    && ['source_decision_coverage', 'topology_binding', 'split_materialization', 'layout_overlap'].every(code => check(report, code))
}

/**
 * Verify one frozen AEA case against its persisted reports and binary outputs.
 * The caller supplies `receipt` only from a successful actual AEA tool result;
 * assistant prose is never a receipt. Existing Host selection remains authoritative.
 * @param fs - scoped Host filesystem provider.
 * @param value - caseId, absolute caseFilePath, stage, trusted receipt and explicit deliveryGoal.
 * @param signal - cancels this read without starting or cancelling native work.
 * @param maxBytes - maximum size of any evidence file.
 * @returns objective booleans plus bound report identities, hashes and diagnostic reasons.
 */
export async function readAeaEvidence(fs: FileSystem, value: JsonValue, signal: AbortSignal, maxBytes: number): Promise<JsonValue> {
  const result: RecordValue = {
    geometryVerified: false, manufacturingVerified: false, fileReadbackVerified: false, goalSatisfied: false, reasons: [],
  }
  try {
    const args = record(value)
    const caseId = text(args.caseId)
    const caseFilePath = text(args.caseFilePath)
    const paths = /^[A-Za-z]:[\\/]/.test(caseFilePath) ? win32 : posix
    if (!paths.isAbsolute(caseFilePath)) throw new Error('An absolute persisted case path is required')
    const directory = paths.dirname(caseFilePath)
    const ledgerPath = paths.join(directory, 'stage-workflow.json')
    const read = async (path: string): Promise<Uint8Array> => {
      const target = await fs.resolve(path, { signal })
      const before = await fs.stat(target, signal)
      if (before?.type !== 'file' || before.size === undefined || before.size < 1 || before.size > maxBytes) throw new Error(`Unreadable or oversized AEA evidence: ${path}`)
      const bytes = await fs.readBytes(target, signal, maxBytes)
      const after = await fs.stat(target, signal)
      if (!after || after.version !== before.version || bytes.byteLength !== before.size) throw new Error(`AEA evidence changed during readback: ${path}`)
      return bytes
    }
    const decode = (bytes: Uint8Array): RecordValue => record(z.json().parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))))
    const caseBytes = await read(caseFilePath), ledgerBytes = await read(ledgerPath)
    const frozen = decode(caseBytes), ledger = decode(ledgerBytes)
    same(frozen.caseId, caseId, 'caseId'); same(ledger.caseId, caseId, 'workflow.caseId')
    same(ledger.inputVersion, frozen.inputVersion, 'inputVersion')
    const parameterHash = text(record(frozen.input).runtimeParametersSha256)
    if (!/^[a-f0-9]{64}$/.test(parameterHash)) throw new Error('Frozen runtime parameter hash is missing')
    const report = async (reference: RecordValue, stage: string): Promise<RecordValue> => {
      const reportId = text(reference.reportId)
      if (!/^[a-zA-Z0-9_-]+$/.test(reportId)) throw new Error('Invalid bound report ID')
      const bytes = await read(paths.join(directory, 'reports', `${reportId}.json`))
      same(hash(bytes), reference.reportSha256, 'report.sha256')
      const data = decode(bytes)
      same(data.reportId, reportId, 'reportId'); same(data.candidateId, reference.candidateId, 'candidateId')
      same(data.inputVersion, frozen.inputVersion, 'report.inputVersion'); same(data.runtimeParametersSha256, parameterHash, 'report.runtimeParametersSha256')
      same(data.stage, stage, 'report.stage')
      return data
    }
    const attempts = list(ledger.attempts).map(record)
    const verified = attempts.filter(item => item.status === 'verified')
    if (!verified.length) throw new Error('No verified AEA candidate exists')
    const latest = verified.at(-1)
    if (!latest) throw new Error('No verified candidate receipt exists')
    const search = await report(latest, 'search')
    result.geometryVerified = geometry(search)
    result.caseId = caseId; result.caseFilePath = caseFilePath; result.inputVersion = text(frozen.inputVersion)
    result.runtimeParametersSha256 = parameterHash
    if (args.stage !== 'geometry') {
      const receipt = record(args.receipt), workflow = record(receipt.workflow)
      same(workflow.caseId, caseId, 'receipt.caseId'); same(workflow.inputVersion, frozen.inputVersion, 'receipt.inputVersion')
      same(workflow.revision, ledger.revision, 'receipt.revision')
      if (record(workflow.manufacturingSelection).deliveryReady !== true) throw new Error('AEA Host selection is not ready for delivery')
      const selected = record(workflow.selectedDelivery)
      if (selected.status !== 'known') throw new Error('Exact selected AEA report is unknown')
      const candidateId = text(selected.candidateId), reportId = text(selected.reportId)
      const matches = list(ledger.manufacturing).map(record).filter(item => item.candidateId === candidateId && item.reportId === reportId && item.status === 'completed')
      if (matches.length !== 1) throw new Error('Selected report has no unique completed manufacturing binding')
      const reference = matches[0]
      if (!reference) throw new Error('Missing completed manufacturing reference')
      same(reference.reportSha256, selected.reportSha256, 'selected.reportSha256')
      if (list(ledger.manufacturing).map(record).some(item => item.status !== 'completed') || ledger.pendingCandidateId != null) throw new Error('AEA native results remain unresolved')
      const data = await report(reference, 'manufacturing')
      const cost = record(data.costEvidence)
      same(cost.reportId, reportId, 'cost.reportId'); same(cost.candidateId, candidateId, 'cost.candidateId')
      same(cost.inputVersion, frozen.inputVersion, 'cost.inputVersion'); same(cost.runtimeParametersSha256, parameterHash, 'cost.runtimeParametersSha256')
      result.manufacturingVerified = geometry(data) && data.manufacturingCompleted === true && data.reviewReady === true
        && check(data, 'fold_angle_layout_current', 'centered-on-bend-glyph-envelope-v3')
        && check(data, 'face_material_preservation', 'face-material-preservation-v3')
        && cost.status === 'known' && typeof cost.threeComponentTotal === 'number' && Number.isFinite(cost.threeComponentTotal)
      result.selectedCandidateId = candidateId
      result.selectedReportId = reportId
      result.selectedReportSha256 = text(reference.reportSha256)
      const files: JsonValue[] = []
      for (const key of ['manufacturingModel', 'laserCutModel']) {
        const path = text(record(data.artifacts)[key]), expected = text(record(data.artifactSha256)[key])
        const published = record(record(selected.artifacts)[key])
        same(published.path, path, `selected.${key}.path`); same(published.sha256, expected, `selected.${key}.sha256`)
        if (!paths.isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Unbound ${key} output`)
        const bytes = await read(path)
        same(hash(bytes), expected, `${key}.sha256`)
        files.push({ path, sha256: expected, bytes: bytes.byteLength })
      }
      result.fileReadbackVerified = files.length === 2 && result.manufacturingVerified
      result.files = files
      const goal = record(args.deliveryGoal)
      if (goal.kind !== 'verified-drawings') throw new Error('Explicit supported deliveryGoal is required; natural-language goals need a decision')
      const metrics = record(data.metrics)
      const limits: [string, JsonValue | undefined][] = [['maxManufacturingScore', cost.threeComponentTotal], ['maxPieces', metrics.manufacturing_piece_count], ['maxWeldActions', metrics.weld_action_count], ['maxBendActions', metrics.bend_action_count]]
      let goalPassed = result.fileReadbackVerified
      for (const [name, actual] of limits) {
        const bound = goal[name]
        if (bound === undefined) continue
        if (typeof bound !== 'number' || !Number.isFinite(bound) || bound < 0) throw new Error(`Invalid explicit goal constraint: ${name}`)
        if (typeof actual !== 'number' || !Number.isFinite(actual) || actual > bound) goalPassed = false
      }
      result.goalSatisfied = goalPassed
      result.deliveryGoal = goal
    }
    if (hash(await read(caseFilePath)) !== hash(caseBytes) || hash(await read(ledgerPath)) !== hash(ledgerBytes)) throw new Error('AEA workflow changed during evidence observation')
    result.scope = 'Software drawing evidence only; workshop acceptance and physical refolding are separate.'
  } catch (error: unknown) {
    result.geometryVerified = false; result.manufacturingVerified = false; result.fileReadbackVerified = false; result.goalSatisfied = false
    result.reasons = [error instanceof Error ? error.message : String(error)]
  }
  return result
}
