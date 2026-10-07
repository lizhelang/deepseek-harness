/** Reference-counted Remote stream shared by the task view and composer dock. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductionSnapshot } from '@deepseek-ai/dsh-production-studio/types'
import type { StudioReadState } from './slots.ts'

/** Inputs supplied by the apply-world Session binding. */
export interface ProductionSourceDeps {
  get: () => Promise<ProductionSnapshot>
  follow: (signal: AbortSignal) => AsyncIterable<ProductionSnapshot>
  subscribeReset: (listener: () => void) => () => void
}

/** Observable source with explicit mutation publication and reconnect. */
export interface ProductionSource extends HostObservable<StudioReadState> {
  publish: (snapshot: ProductionSnapshot) => void
  refresh: () => void
  dispose: () => void
}

/**
 * Follow production state while any Studio surface is mounted. Later revisions
 * outrank a delayed initial read; cleanup aborts the stream and rejects late data.
 * @param deps - Host reads and transport-generation reset subscription.
 * @returns a stable observable whose fields are actual Host observations.
 */
export function createProductionSource(deps: ProductionSourceDeps): ProductionSource {
  let state: StudioReadState = { snapshot: null, loading: true, error: null }
  let controller: AbortController | undefined
  let resetDispose: (() => void) | undefined
  let epoch = 0
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  const publish = (snapshot: ProductionSnapshot): void => {
    if (state.snapshot !== null && snapshot.revision < state.snapshot.revision) return
    state = { snapshot, loading: false, error: snapshot.error ?? null }
    emit()
  }
  const fail = (error: unknown, generation: number): void => {
    if (generation !== epoch || controller?.signal.aborted) return
    state = { ...state, loading: false, error: error instanceof Error ? error.message : String(error) }
    emit()
  }
  const stop = (): void => { epoch++; controller?.abort(); controller = undefined }
  const refresh = (): void => {
    stop()
    if (listeners.size === 0) return
    const generation = epoch
    controller = new AbortController()
    const signal = controller.signal
    state = { ...state, loading: state.snapshot === null, error: null }; emit()
    void deps.get().then((snapshot) => { if (generation === epoch) publish(snapshot) }, (error: unknown) => { fail(error, generation) })
    void (async () => {
      try { for await (const snapshot of deps.follow(signal)) { if (generation === epoch) publish(snapshot) } }
      catch (error) { fail(error, generation) }
    })()
  }
  return {
    getSnapshot: () => state,
    publish, refresh,
    dispose: () => { stop(); resetDispose?.(); resetDispose = undefined; listeners.clear() },
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) { resetDispose = deps.subscribeReset(refresh); refresh() }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) { stop(); resetDispose?.(); resetDispose = undefined }
      }
    },
  }
}
