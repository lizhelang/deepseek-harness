/** Pure-props shares for Production Studio's registered surfaces. */
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductionGraph, ProductionSnapshot, ProductionRef, AnswerProductionRequest, StartProductionRunRequest } from '@deepseek-ai/dsh-production-studio/types'
import type { createStudioDraftStore } from './stores.ts'

/** Authoritative read status; partial task data is never synthesized by the Client. */
export interface StudioReadState { snapshot: ProductionSnapshot | null; loading: boolean; error: string | null }

/** Session-bound mutations return an error line or null on success. */
export interface StudioInjected {
  hooks: { production: HostObservable<StudioReadState> }
  saveGraph: (expectedVersion: number, graph: ProductionGraph) => Promise<string | null>
  start: (request: StartProductionRunRequest) => Promise<string | null>
  pause: (request: ProductionRef) => Promise<string | null>
  resume: (request: ProductionRef) => Promise<string | null>
  answer: (request: AnswerProductionRequest) => Promise<string | null>
  reconcile: (request: ProductionRef) => Promise<string | null>
  refresh: () => void
}

/** Shared surface props delivered by slot composition. */
export type StudioSurfaceProps = InjectFace<StudioInjected> & PropsLocale<'productionStudio'> & PropsStore<ReturnType<typeof createStudioDraftStore>>
/** Full monitoring/editor view props. */
export type StudioViewProps = PropsRuntime<'conversation.view'> & StudioSurfaceProps
/** Full above-composer dock props. */
export type StudioDockProps = PropsRuntime<'conversation.input.dock'> & StudioSurfaceProps
