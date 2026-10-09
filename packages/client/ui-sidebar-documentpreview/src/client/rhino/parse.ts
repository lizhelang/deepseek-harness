/** Official Rhino loader with bundled decoder assets and a bounded, cancellable lifetime. */
import { LoadingManager, type Object3D } from 'three'
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js'
import { disposeRhinoScene } from './scene.ts'
import type { RhinoLimits } from './types.ts'
import { parseRhinoWireframe } from './wireframe.ts'
import { addRhinoWireframes } from './wireframe-scene.ts'
import { applyRhinoVisibility } from './visibility.ts'

declare global {
  /** Same-version rhino3dm wrapper included by the package build. */
  const __DSH_RHINO_JS_SOURCE__: string
  /** Same-version rhino3dm WASM included by the package build. */
  const __DSH_RHINO_WASM_BASE64__: string
}

/** Pinned loader internals needed because dispose does not cancel pending library initialization. */
type CancellableRhinoLoader = Rhino3dmLoader & {
  _getWorker: (cost: number) => Promise<Worker>
  workerSourceURL: string
}

/**
 * @param source - Borrowed model bytes.
 * @param limits - Total decode lifetime.
 * @param signal - Document lifetime.
 * @returns Official scene with explicitly marked edge previews for absent surface meshes.
 */
export async function parseRhino(source: Uint8Array<ArrayBuffer>, limits: RhinoLimits, signal: AbortSignal): Promise<Object3D> {
  const started = performance.now()
  const model = await loadRhino(source, limits, signal)
  try {
    const remaining = limits.timeoutMs - (performance.now() - started)
    if (remaining <= 0) throw new Error('timeout')
    const wireframe = await parseRhinoWireframe(source, signal, remaining)
    signal.throwIfAborted()
    addRhinoWireframes(model, wireframe)
    applyRhinoVisibility(model)
    return model
  } catch (error) { disposeRhinoScene(model); throw error }
}

/** Decode original supported geometry with the pinned official loader. */
function loadRhino(source: Uint8Array<ArrayBuffer>, limits: RhinoLimits, signal: AbortSignal): Promise<Object3D> {
  signal.throwIfAborted()
  const assets = localRhinoAssets()
  const manager = new LoadingManager()
  manager.setURLModifier((url) => {
    if (url === 'rhino3dm.js') return assets.js
    if (url === 'rhino3dm.wasm') return assets.wasm
    throw new Error('Unbundled Rhino decoder asset')
  })
  const loader = new Rhino3dmLoader(manager).setWorkerLimit(1) as CancellableRhinoLoader
  let retired = false
  const isRetired = (): boolean => retired
  const dispose = (): void => {
    retired = true
    loader.dispose()
    if (loader.workerSourceURL) URL.revokeObjectURL(loader.workerSourceURL)
    assets.dispose()
  }
  const getWorker = loader._getWorker.bind(loader)
  loader._getWorker = async (cost) => {
    if (isRetired()) throw new DOMException('Preview closed', 'AbortError')
    const worker = await getWorker(cost)
    // The pinned upstream loader can finish library setup after dispose().
    if (isRetired()) { worker.terminate(); dispose(); throw new DOMException('Preview closed', 'AbortError') }
    return worker
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); dispose() }
    const fail = (error: Error): void => { if (settled) return; settled = true; finish(); reject(error) }
    const abort = (): void => { fail(new DOMException('Preview closed', 'AbortError')) }
    const timer = setTimeout(() => { fail(new Error('timeout')) }, limits.timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    try {
      // Rhino3dmLoader transfers this buffer to its Worker; retained document bytes must survive.
      loader.parse(source.slice().buffer, (model) => {
        if (settled) { disposeRhinoScene(model); dispose(); return }
        settled = true
        finish()
        resolve(model)
      }, () => { fail(new Error('invalid')) })
    } catch (error) { fail(new Error('invalid', { cause: error })) }
  })
}

function localRhinoAssets(): { js: string; wasm: string; dispose: () => void } {
  const binary = Uint8Array.from(atob(__DSH_RHINO_WASM_BASE64__), character => character.charCodeAt(0))
  const js = URL.createObjectURL(new Blob([__DSH_RHINO_JS_SOURCE__], { type: 'text/javascript' }))
  let wasm: string
  try { wasm = URL.createObjectURL(new Blob([binary], { type: 'application/wasm' })) }
  catch (error) { URL.revokeObjectURL(js); throw error }
  let disposed = false
  return { js, wasm, dispose: () => { if (disposed) return; disposed = true; URL.revokeObjectURL(js); URL.revokeObjectURL(wasm) } }
}
