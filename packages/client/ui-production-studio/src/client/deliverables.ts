/** Read-only projection of the Host's completed, verified AEA delivery. */
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio/types'

/** One file whose saved bytes and digest were verified by the internal producer. */
export interface VerifiedDeliveryFile {
  path: string
  sha256: string
  bytes: number
}

/** Completed software evidence; physical and workshop acceptance remain separate. */
export interface VerifiedDelivery {
  files: VerifiedDeliveryFile[]
  observedAt: number
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function verifiedFile(value: unknown): VerifiedDeliveryFile | null {
  const file = record(value)
  if (file === null || typeof file.path !== 'string' ||
    !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(file.path) ||
    typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
    typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) return null
  return { path: file.path, sha256: file.sha256, bytes: file.bytes }
}

/**
 * Expose saved files only from a completed delivery's latest internal receipt.
 * @param run - The actual Host snapshot of one frozen production run.
 * @returns verified delivery files, or null when evidence is incomplete or invalid.
 */
export function verifiedDelivery(run: ProductionRun): VerifiedDelivery | null {
  if (run.phase !== 'complete') return null
  const deliveries = run.tasks.filter(task => task.phase === 'complete' &&
    run.graph.nodes.some(node => node.id === task.nodeId && node.kind === 'delivery'))
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const delivery = deliveries[0]
  if (delivery === undefined || !(['geometry', 'manufacturing', 'files', 'goal'] as const)
    .every(certificate => delivery.certificates.includes(certificate))) return null
  const receipts = delivery.evidence.filter(evidence => evidence.kind === 'tool' &&
    evidence.toolName === 'production_aea_evidence')
  const receipt = receipts.reduce<(typeof receipts)[number] | undefined>((latest, item) =>
    latest === undefined || item.observedAt >= latest.observedAt ? item : latest, undefined)
  if (receipt === undefined) return null
  const data = record(receipt.data)
  if (data === null || data.geometryVerified !== true || data.manufacturingVerified !== true ||
    data.fileReadbackVerified !== true || data.goalSatisfied !== true ||
    !Array.isArray(data.files) || data.files.length === 0) return null
  const files: VerifiedDeliveryFile[] = []
  for (const value of data.files) {
    const file = verifiedFile(value)
    if (file === null || files.some(previous => previous.path === file.path)) return null
    files.push(file)
  }
  return { files, observedAt: receipt.observedAt }
}
