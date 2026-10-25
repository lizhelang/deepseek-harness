/** Pure-props shares for Production Studio's registered surfaces. */
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductionSnapshot, ProductionRef } from '@deepseek-ai/dsh-production-studio/types'
import type { createStudioDraftStore } from './stores.ts'

/** Host reads keep transport failures separate from snapshot task errors; the Client never synthesizes task data. */
export interface StudioReadState { snapshot: ProductionSnapshot | null; loading: boolean; error: string | null }

/** Session-bound mutations return an error line or null on success. */
export interface StudioInjected {
  hooks: { production: HostObservable<StudioReadState> }
  pause: (request: ProductionRef) => Promise<string | null>
  resume: (request: ProductionRef) => Promise<string | null>
  reconcile: (request: ProductionRef) => Promise<string | null>
  /** Queue one ordinary user message in this Session's conversation. */
  send: (text: string) => Promise<string | null>
  refresh: () => void
}

/** Shared surface props delivered by slot composition. */
export type StudioSurfaceProps = InjectFace<StudioInjected> & PropsLocale<'productionStudio'> & PropsStore<ReturnType<typeof createStudioDraftStore>>
/** Full monitoring and run policy view props. */
export type StudioViewProps = PropsRuntime<'conversation.view'> & StudioSurfaceProps
/** Full above-composer dock props. */
export type StudioDockProps = PropsRuntime<'conversation.input.dock'> & StudioSurfaceProps
