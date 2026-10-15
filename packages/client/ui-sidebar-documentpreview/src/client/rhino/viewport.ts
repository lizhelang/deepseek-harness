/** Disposable read-only Three.js viewport with Rhino's Z-up coordinates. */
import { AmbientLight, DirectionalLight, OrthographicCamera, Scene, Vector3, WebGLRenderer, type Object3D } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { frameRhinoCamera, rhinoBounds, setRhinoLayerVisible } from './scene.ts'
import { RHINO_PREVIEW_BACKGROUND } from './contrast.ts'

/** View controls owned by one mounted document body. */
export interface RhinoViewport {
  /** @param view - Current viewing direction, or an explicit Rhino standard view. */
  fit: (view?: 'top' | 'iso') => void
  /** @param index - File layer index. @param visible - Requested visibility. */
  layer: (index: number, visible: boolean) => void
  /** Remove controls, observers, canvas, and GPU context. Model resources belong to the caller. */
  dispose: () => void
}

/**
 * Attach a Z-up viewport whose controls and GPU context end on disposal.
 * @param container - Empty viewport element.
 * @param model - Decoded model retained by the caller.
 * @param label - Accessible viewport description.
 * @returns Disposable camera and layer controls.
 */
export function createRhinoViewport(container: HTMLElement, model: Object3D, label: string): RhinoViewport {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false })
  const scene = new Scene()
  let controls: OrbitControls | undefined
  let observer: ResizeObserver | undefined
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    controls?.dispose()
    scene.remove(model)
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(RHINO_PREVIEW_BACKGROUND)
    renderer.domElement.setAttribute('aria-label', label)
    renderer.domElement.setAttribute('role', 'img')
    scene.add(model, new AmbientLight(0xffffff, 2))
    const light = new DirectionalLight(0xffffff, 3)
    light.position.set(1, -1, 2)
    scene.add(light)
    const camera = new OrthographicCamera()
    camera.up.set(0, 0, 1)
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    const orbit = controls
    const render = (): void => { if (!disposed) renderer.render(scene, camera) }
    const frame = () => ({ width: Math.max(container.clientWidth, 1), height: Math.max(container.clientHeight, 1) })
    const fit = (view?: 'top' | 'iso'): void => {
      const bounds = rhinoBounds(model)
      if (!bounds) { render(); return }
      const direction = view === 'top' ? new Vector3(0, -0.0001, 1)
        : view === 'iso' ? new Vector3(1, -1, 1) : camera.position.clone().sub(orbit.target)
      if (direction.lengthSq() === 0) direction.set(1, -1, 1)
      const size = frame()
      orbit.target.copy(frameRhinoCamera(camera, bounds, size.width / size.height, direction))
      orbit.update()
      render()
    }
    const resize = (): void => {
      const size = frame()
      const halfHeight = (camera.top - camera.bottom) / 2
      camera.left = -halfHeight * size.width / size.height
      camera.right = halfHeight * size.width / size.height
      camera.updateProjectionMatrix()
      renderer.setSize(size.width, size.height)
      render()
    }
    orbit.addEventListener('change', render)
    container.appendChild(renderer.domElement)
    observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()
    fit('iso')
    return {
      fit,
      layer: (index, visible) => { setRhinoLayerVisible(model, index, visible); render() },
      dispose: () => { orbit.removeEventListener('change', render); dispose() },
    }
  } catch (error) { dispose(); throw error }
}
