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
 * Put a run at its most actionable branch while respecting explicit pause and completion.
 * @param run - One workpiece/run and its branch roster.
 * @returns ordered section name.
 */
export function runGroup(run: ProductionRun): TaskGroup {
  if (run.phase === 'complete') return 'complete'
  if (run.tasks.some(task => branchGroup(task) === 'critical')) return 'critical'
  if (run.phase === 'unknown') return 'critical'
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
