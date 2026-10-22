/** Session-owned unsent text and graph edits, independent of live task updates. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ProductionGraph } from '@deepseek-ai/dsh-production-studio/types'
import { PRESETS, type RunPolicy } from './run-policy.ts'

/** Drafts survive view switches and are never replaced by a streaming snapshot. */
export interface StudioDraftState {
  objective: string
  input: string
  answers: Record<string, string>
  jsonFields: Record<string, string>
  graph: ProductionGraph | null
  baseVersion: number | null
  dirty: boolean
  dockExpanded: boolean
  goal: StudioGoalDraft
  goalAcknowledged: boolean
  /** Run policy draft, applied only by an explicit chat request. */
  policy: RunPolicy
}

/** User-entered objective thresholds; empty values mean no numeric restriction. */
export interface StudioGoalDraft {
  maxPieces: string
  maxWeldActions: string
  maxBendActions: string
  maxManufacturingScore: string
}

/** Explicit viewing-draft writes shared across the three surfaces. */
export type StudioDraftActions = {
  objective: (state: StudioDraftState, value: string) => void
  input: (state: StudioDraftState, value: string) => void
  answer: (state: StudioDraftState, key: string, value: string) => void
  json: (state: StudioDraftState, key: string, value: string) => void
  graph: (state: StudioDraftState, value: ProductionGraph, baseVersion: number) => void
  loaded: (state: StudioDraftState, value: ProductionGraph) => void
  expanded: (state: StudioDraftState, value: boolean) => void
  goal: (state: StudioDraftState, field: keyof StudioGoalDraft, value: string) => void
  goalAcknowledged: (state: StudioDraftState, value: boolean) => void
  policy: (state: StudioDraftState, value: RunPolicy) => void
}

/**
 * Declare a shared viewing/draft store for all three Studio surfaces.
 * @returns Session-scoped editable state with explicit write operations.
 */
export function createStudioDraftStore(): EngineStoreHandle<StudioDraftState, StudioDraftActions> {
  return defineStore({
    init: (): StudioDraftState => ({ objective: '', input: '{}', answers: {}, jsonFields: {}, graph: null, baseVersion: null, dirty: false, dockExpanded: false,
      goal: { maxPieces: '', maxWeldActions: '', maxBendActions: '', maxManufacturingScore: '' }, goalAcknowledged: false, policy: { ...PRESETS.standard } }),
    actions: {
      objective: (state, value: string) => { state.objective = value; state.goalAcknowledged = false },
      input: (state, value: string) => { state.input = value; state.goalAcknowledged = false },
      answer: (state, key: string, value: string) => { state.answers[key] = value },
      json: (state, key: string, value: string) => { state.jsonFields[key] = value; state.dirty = true },
      graph: (state, value: ProductionGraph, baseVersion: number) => {
        state.graph = value; state.baseVersion = baseVersion; state.dirty = true
      },
      loaded: (state, value: ProductionGraph) => {
        state.graph = value; state.baseVersion = value.version; state.dirty = false; state.jsonFields = {}
      },
      expanded: (state, value: boolean) => { state.dockExpanded = value },
      goal: (state, field: keyof StudioGoalDraft, value: string) => { state.goal[field] = value; state.goalAcknowledged = false },
      goalAcknowledged: (state, value: boolean) => { state.goalAcknowledged = value },
      policy: (state, value: RunPolicy) => { state.policy = value },
    },
  })
}
