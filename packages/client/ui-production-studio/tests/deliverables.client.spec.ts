import { describe, expect, it } from 'vitest'
import { verifiedDelivery } from '../src/client/deliverables.ts'
import { deliveredRun } from './fixtures.ts'

describe('completed delivery projection', () => {
  it('exposes the saved file bytes and digest from the internal delivery receipt', () => {
    expect(verifiedDelivery(deliveredRun())).toEqual({ observedAt: 3, files: [
      { path: '/outputs/manufacturing.3dm', sha256: 'a'.repeat(64), bytes: 8192 },
      { path: '/outputs/laser-cut.3dm', sha256: 'b'.repeat(64), bytes: 4096 },
    ] })
  })
  it('refuses model output, another producer, unfinished delivery or missing proof', () => {
    const fromOutput = deliveredRun()
    fromOutput.tasks[0]!.output = fromOutput.tasks[0]!.evidence[0]!.data
    fromOutput.tasks[0]!.evidence = []
    expect(verifiedDelivery(fromOutput)).toBeNull()
    const otherProducer = deliveredRun()
    otherProducer.tasks[0]!.evidence[0]!.toolName = 'agent_report'
    expect(verifiedDelivery(otherProducer)).toBeNull()
    const unfinished = deliveredRun()
    unfinished.tasks[0]!.phase = 'running'
    expect(verifiedDelivery(unfinished)).toBeNull()
    const incomplete = deliveredRun()
    incomplete.tasks[0]!.certificates = ['geometry', 'manufacturing', 'files']
    expect(verifiedDelivery(incomplete)).toBeNull()
  })
  it('does not fall back to an older passing receipt when the latest receipt failed', () => {
    const run = deliveredRun()
    run.tasks[0]!.evidence.push({ ...run.tasks[0]!.evidence[0]!, observedAt: 4,
      data: { geometryVerified: true, manufacturingVerified: false, fileReadbackVerified: false, goalSatisfied: false } })
    expect(verifiedDelivery(run)).toBeNull()
  })
  it('requires positive saved bytes, full digests and absolute unique paths', () => {
    for (const invalid of [
      { path: 'relative.3dm', sha256: 'a'.repeat(64), bytes: 10 },
      { path: '/output.3dm', sha256: 'fake', bytes: 10 },
      { path: '/output.3dm', sha256: 'a'.repeat(64), bytes: 0 },
    ]) {
      const run = deliveredRun()
      run.tasks[0]!.evidence[0]!.data = { geometryVerified: true, manufacturingVerified: true,
        fileReadbackVerified: true, goalSatisfied: true, files: [invalid] }
      expect(verifiedDelivery(run)).toBeNull()
    }
  })
})
