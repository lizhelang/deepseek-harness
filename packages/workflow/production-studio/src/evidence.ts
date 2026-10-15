/** Lossless, Session-bound archival of diagnostic receipts; never an objective certificate. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProductionEvidence } from './types.ts'

/** Persisted diagnostic text and the Session identity required for exact readback. */
export const evidenceBlobSchema = z.object({ sessionId: z.string(), text: z.string() }).strict()
type EvidenceBlob = z.infer<typeof evidenceBlobSchema>
const referenceSchema = z.object({ productionEvidenceReference: z.object({
  version: z.literal(1), sessionId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
}).strict() }).strict()
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** Persisted blobs precede references and are read back with their complete observation identity. */
export class EvidenceArchive {
  constructor(private readonly table: KvTable<string, EvidenceBlob>) {}

  /**
   * Resolve one inline observation or verify and restore its archived bytes.
   * @param sessionId - owning Session, never taken from the reference alone.
   * @param evidence - complete retained observation, including its identity metadata.
   * @returns the original observation; absent, corrupt, or foreign blobs throw.
   */
  read(sessionId: SessionId, evidence: ProductionEvidence): ProductionEvidence {
    const data = evidence.data
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !('productionEvidenceReference' in data)) return structuredClone(evidence)
    const ref = referenceSchema.parse(data).productionEvidenceReference
    if (ref.sessionId !== sessionId) throw new Error('Evidence reference belongs to another Session')
    const stored = this.table.get(JSON.stringify([sessionId, ref.sha256]))
    if (!stored || stored.sessionId !== sessionId || Buffer.byteLength(stored.text) !== ref.bytes || digest(stored.text) !== ref.sha256) throw new Error('Archived evidence is missing or its byte identity changed')
    const original = z.object({ kind: z.enum(['tool', 'file', 'human', 'agent']), nodeId: z.string(), attempt: z.number().int().nonnegative(),
      toolName: z.string().optional(), data: z.json(), observedAt: z.number() }).strict().parse(JSON.parse(stored.text))
    if (original.kind !== evidence.kind || original.nodeId !== evidence.nodeId || original.attempt !== evidence.attempt
      || original.toolName !== evidence.toolName || original.observedAt !== evidence.observedAt) throw new Error('Archived evidence observation identity changed')
    if (typeof original.data === 'object' && original.data !== null && !Array.isArray(original.data) && 'productionEvidenceReference' in original.data) throw new Error('Nested evidence references are not supported')
    return { ...evidence, data: original.data }
  }

  /**
   * Archive ordinary diagnostic data until the retained array fits, when possible.
   * Objective, reconciliation, human and file records remain inline. Callers still
   * enforce their complete retained bound; gates enforce the restored byte bound.
   * @param sessionId - owning Session.
   * @param evidence - observations in their original order.
   * @param limit - unchanged configured retained byte limit.
   * @returns detached observations after durable blob writes; never drops a record.
   */
  async retain(sessionId: SessionId, evidence: ProductionEvidence[], limit: number): Promise<ProductionEvidence[]> {
    // Validate existing references even when no further compaction is needed.
    for (const item of evidence) this.read(sessionId, item)
    const retained = structuredClone(evidence)
    const candidates = evidence.map((item, index) => ({ item, index, bytes: size(item) }))
      .filter(({ item }) => {
        const data = item.data
        return item.kind === 'tool' && item.toolName !== 'production_aea_evidence'
          && !(typeof data === 'object' && data !== null && !Array.isArray(data)
            && ['productionEvidenceReference', 'nativeReconciliation', 'productionContinuation'].some(key => key in data))
      })
      .sort((a, b) => b.bytes - a.bytes)
    for (const { item, index, bytes } of candidates) {
      if (size(retained) <= limit) break
      const text = JSON.stringify(item), sha256 = digest(text)
      const replacement: ProductionEvidence = { ...item,
        data: { productionEvidenceReference: { version: 1, sessionId, sha256, bytes: Buffer.byteLength(text) } } }
      if (size(replacement) >= bytes) continue
      const key = JSON.stringify([sessionId, sha256]), stored = this.table.get(key)
      if (stored && (stored.sessionId !== sessionId || stored.text !== text)) throw new Error('Archived evidence conflicts with its immutable identity')
      if (!stored) await this.table.put(key, { sessionId, text })
      // Check the persisted observation before publishing its compact reference.
      this.read(sessionId, replacement)
      retained[index] = replacement
    }
    return retained
  }
}
