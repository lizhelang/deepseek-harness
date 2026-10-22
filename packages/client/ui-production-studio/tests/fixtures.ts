/** Real domain-shaped fixtures for presentation tests; never shipped by the plugin. */
import type { ProductionCaseView, ProductionGraph, ProductionNode, ProductionNodePhase, ProductionRun, ProductionRunId, ProductionSnapshot } from '@deepseek-ai/dsh-production-studio/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const SID = 'studio-test' as SessionId

export function graph(): ProductionGraph {
  const names = ['baseline', 'geometry', 'manufacturing', 'files', 'goal', 'delivery']
  const types = ['input', 'candidate', 'geometry', 'manufacturing', 'files', 'delivery'] as const
  const nodes: ProductionNode[] = names.map((id, index) => ({
    id, label: id, kind: id === 'baseline' ? 'agent' : id === 'delivery' ? 'delivery' : 'gate', x: 40 + index % 3 * 290, y: 40 + Math.floor(index / 3) * 240,
    inputs: [{ id: 'input', type: types[index]! }],
    outputs: id === 'delivery' ? [] : [{ id: 'success', type: types[index + 1]!, outlet: 'success' }],
    maxAttempts: 3, protected: id !== 'baseline',
    config: id === 'baseline' || id === 'delivery' ? {} : {
      certification: id === 'files' ? 'files' : id as 'geometry' | 'manufacturing' | 'goal', evidencePath: `${id}Verified`, expected: true,
    },
  }))
  return { version: 1, name: 'Fixture workflow', maxExecutions: 24, maxConcurrent: 3, nodes,
    edges: names.slice(1).map((id, index) => ({ id: `main-${index}`, fromNode: names[index]!, fromPort: 'success', toNode: id, toPort: 'input' })),
  }
}

export function run(id: string, taskPhase: ProductionNodePhase): ProductionRun {
  return { id: id as ProductionRunId, revision: 2, objective: `Workpiece ${id}`, graph: graph(), phase: taskPhase === 'complete' ? 'complete' : taskPhase === 'paused' ? 'paused' : 'active',
    executions: 1, input: {}, tasks: [{ nodeId: 'baseline', phase: taskPhase, attempts: 1, message: `Status ${id}`, evidence: [], certificates: [], updatedAt: 2 }],
    history: [], createdAt: 1, updatedAt: 2,
  }
}

export function snapshot(runs: ProductionRun[] = []): ProductionSnapshot {
  return { sessionId: SID, revision: 2, graph: graph(), runs, capabilities: { subagent: true, tools: ['native-test'], filesystem: true } }
}

export function deliveredRun(): ProductionRun {
  const delivered = run('delivered', 'complete')
  delivered.tasks = [{ nodeId: 'delivery', phase: 'complete', attempts: 1, message: 'Verified delivery', updatedAt: 3,
    certificates: ['geometry', 'manufacturing', 'files', 'goal'], evidence: [{
      kind: 'tool', nodeId: 'goal', attempt: 1, toolName: 'production_aea_evidence', observedAt: 3,
      data: { geometryVerified: true, manufacturingVerified: true, fileReadbackVerified: true, goalSatisfied: true,
        files: [{ path: '/outputs/manufacturing.3dm', sha256: 'a'.repeat(64), bytes: 8192 },
          { path: '/outputs/laser-cut.3dm', sha256: 'b'.repeat(64), bytes: 4096 }] },
    }],
  }]
  return delivered
}

/**
 * AEA case projection shaped like a real Host receipt fold.
 * @param overrides - fields replaced on the default view.
 * @returns a complete case view.
 */
export function caseView(overrides: Partial<ProductionCaseView> = {}): ProductionCaseView {
  return { caseId: 'case0001abcd', inputVersion: 'v1', revision: 9, phase: 'improve', stage: 'improvement_proposal',
    candidates: { used: 2, limit: 8 }, hostCalls: { used: 12, limit: 48 },
    rows: [
      { candidateId: 'c1c1c1c1c1', kind: 'baseline', searchStatus: 'verified', searchCounts: { pieces: 1, bends: 10, welds: 7 }, manufacturing: { status: 'passed', score: 41.5, pieces: 1 } },
      { candidateId: 'c2c2c2c2c2', parentCandidateId: 'c1c1c1c1c1', kind: 'improvement', searchStatus: 'verified', searchScore: 39.982, searchCounts: { pieces: 2, bends: 9, welds: 8 }, manufacturing: { status: 'failed' }, failure: 'bend_angle_metadata' },
    ],
    bestSearchCandidateId: 'c2c2c2c2c2', finishBlockers: ['Try the strip source'], nextActions: ['suggest_candidates', 'finish_custom'],
    observedAt: 1, ...overrides }
}
