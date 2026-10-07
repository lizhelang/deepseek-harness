import { describe, expect, it } from 'vitest'
import { branchGroup, matchesRun, orderedBranches, runGroup } from '../src/client/task-order.ts'
import { run } from './fixtures.ts'

describe('workpiece priority', () => {
  it('keeps attempts nested while placing intervention before ordinary execution', () => {
    const sample = run('one', 'running')
    const branches = ['complete', 'running', 'waiting', 'human', 'unknown', 'paused'].map(phase => ({ ...sample.tasks[0]!, phase })) as typeof sample.tasks
    expect(orderedBranches(branches).map(task => task.phase)).toEqual(['unknown', 'human', 'waiting', 'running', 'paused', 'complete'])
    for (const phase of ['blocked', 'unknown'] as const) expect(branchGroup({ ...sample.tasks[0]!, phase })).toBe('critical')
    expect(runGroup({ ...sample, tasks: branches })).toBe('critical')
    expect(runGroup(run('two', 'human'))).toBe('human')
    expect(runGroup(run('three', 'running'))).toBe('running')
    expect(runGroup(run('four', 'waiting'))).toBe('waiting')
    expect(runGroup(run('five', 'paused'))).toBe('paused')
    expect(runGroup(run('six', 'complete'))).toBe('complete')
  })
  it('searches objective, branch labels and blockers without mutating the run', () => {
    const sample = run('Valve', 'blocked')
    expect(matchesRun(sample, ' valve ')).toBe(true)
    expect(matchesRun(sample, 'BASELINE')).toBe(true)
    expect(matchesRun(sample, 'Status')).toBe(true)
    expect(matchesRun(sample, 'other workpiece')).toBe(false)
  })
  it('prioritizes actual human and dependency tasks over a legacy blocked run summary', () => {
    const human = run('human', 'human'); human.phase = 'blocked'
    const waiting = run('waiting', 'waiting'); waiting.phase = 'blocked'
    expect(runGroup(human)).toBe('human')
    expect(runGroup(waiting)).toBe('waiting')
    expect(runGroup({ ...human, tasks: [...human.tasks, { ...human.tasks[0]!, nodeId: 'geometry', phase: 'unknown' }] })).toBe('critical')
    expect(runGroup({ ...human, tasks: [...human.tasks, { ...human.tasks[0]!, nodeId: 'geometry', phase: 'blocked' }] })).toBe('critical')
    expect(runGroup({ ...waiting, tasks: [] })).toBe('critical')
  })
})
