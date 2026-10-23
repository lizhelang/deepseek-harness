/** Session-owned viewing state and the run policy draft, independent of live task updates. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { PRESETS, type RunPolicy } from './run-policy.ts'

/** Drafts survive view switches and are never replaced by a streaming snapshot. */
export interface StudioDraftState {
  dockExpanded: boolean
  /** Run policy draft, applied only by an explicit chat request. */
  policy: RunPolicy
}

/** Explicit viewing-draft writes shared across the Studio surfaces. */
export type StudioDraftActions = {
  expanded: (state: StudioDraftState, value: boolean) => void
  policy: (state: StudioDraftState, value: RunPolicy) => void
}

/**
 * Declare a shared viewing/draft store for all Studio surfaces.
 * @returns Session-scoped editable state with explicit write operations.
 */
export function createStudioDraftStore(): EngineStoreHandle<StudioDraftState, StudioDraftActions> {
  return defineStore({
    init: (): StudioDraftState => ({ dockExpanded: false, policy: { ...PRESETS.standard } }),
    actions: {
      expanded: (state, value: boolean) => { state.dockExpanded = value },
      policy: (state, value: RunPolicy) => { state.policy = value },
    },
  })
}
