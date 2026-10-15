/** Stable priority ordering without expanding attempts into top-level rows. */
import type { ProductionRun, ProductionTask } from '@deepseek-ai/dsh-production-studio/types'

/** Monitor section order from intervention to archived delivery. */
export const TASK_GROUPS = ['critical', 'human', 'waiting', 'running', 'paused', 'complete'] as const
/** One ordered monitor section. */
export type TaskGroup = typeof TASK_GROUPS[number]

/**
 * Map one current branch status to its intervention priority.
 * @param task - Host-authored branch snapshot.
 * @returns ordered section name.
 */
export function branchGroup(task: ProductionTask): TaskGroup {
  switch (task.phase) {
    case 'blocked': case 'unknown': return 'critical'
    case 'human': return 'human'
    case 'waiting': return 'waiting'
    case 'running': case 'ready': return 'running'
    case 'paused': return 'paused'
    case 'complete': case 'skipped': return 'complete'
  }
}

/**
 * Put a run at its current intervention priority; active conversation recovery supersedes settled failures.
 * @param run - One workpiece/run and its branch roster.
 * @returns ordered section name.
 */
export function runGroup(run: ProductionRun): TaskGroup {
  if (run.phase === 'complete') return 'complete'
  if (run.phase === 'unknown' || run.tasks.some(task => task.phase === 'unknown')) return 'critical'
  if (run.mode === 'conversation' && run.phase === 'active' && run.tasks.some(task => task.phase === 'running' || task.phase === 'ready')) {
    return run.tasks.some(task => task.phase === 'human') ? 'human' : 'running'
  }
  if (run.tasks.some(task => branchGroup(task) === 'critical')) return 'critical'
  if (run.tasks.some(task => task.phase === 'human')) return 'human'
  if (run.phase === 'paused') return 'paused'
  if (run.tasks.some(task => task.phase === 'running' || task.phase === 'ready')) return 'running'
  if (run.tasks.some(task => task.phase === 'waiting')) return 'waiting'
  if (run.phase === 'blocked') return 'critical'
  return 'paused'
}

/**
 * Sort branches by current intervention priority, preserving graph order for ties.
 * @param tasks - Host-authored branches.
 * @returns a detached ordered array.
 */
export function orderedBranches(tasks: readonly ProductionTask[]): ProductionTask[] {
  return [...tasks].sort((left, right) => TASK_GROUPS.indexOf(branchGroup(left)) - TASK_GROUPS.indexOf(branchGroup(right)))
}

/**
 * Select the current conversation action for the summary while retaining historical branch diagnostics.
 * @param run - One workpiece/run and its branch roster.
 * @returns the branch to preview, or undefined for fully completed branches.
 */
export function prominentBranch(run: ProductionRun): ProductionTask | undefined {
  const branches = orderedBranches(run.tasks)
  const group = runGroup(run)
  if (run.mode === 'conversation' && run.phase === 'active' && (group === 'running' || group === 'human')) {
    return branches.find(task => branchGroup(task) === group)
  }
  return branches.find(task => task.phase !== 'complete' && task.phase !== 'skipped')
}

/**
 * Match a workpiece, branch name or present blocker against a plain-text filter.
 * @param run - Workpiece and branch data.
 * @param query - User search input.
 * @returns whether one current field contains the case-insensitive query.
 */
export function matchesRun(run: ProductionRun, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return needle === '' || [run.objective, run.id, ...run.graph.nodes.map(node => node.label), ...run.tasks.map(task => task.message)]
    .some(value => value.toLocaleLowerCase().includes(needle))
}
