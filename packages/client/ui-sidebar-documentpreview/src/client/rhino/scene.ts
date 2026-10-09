/** Three.js scene inspection, camera framing, layer visibility, and GPU disposal. */
import { Box3, BufferGeometry, Material, Mesh, Line, Points, Sprite, Texture, Vector3, type Object3D, type OrthographicCamera } from 'three'

import { changeRhinoLayer, readRhinoLayers, type RhinoLayer } from './visibility.ts'

/** Rendered content counts and decoder limitations presented beside the viewport. */
export interface RhinoSceneInfo {
  readonly objectCount: number
  readonly visibleObjectCount: number
  readonly wireframeCount: number
  readonly missingFaceCount: number
  readonly omittedEdgeCount: number
  readonly omittedObjectCount: number
  readonly layers: readonly RhinoLayer[]
  readonly warnings: readonly string[]
}

/** @param model - Decoded Rhino scene. @returns Displayed object counts, layers, and decoder warnings. */
export function inspectRhinoScene(model: Object3D): RhinoSceneInfo {
  const all = new Set<string>()
  const visible = new Set<string>()
  model.traverse((object) => { if (drawable(object)) all.add(objectIdentity(object)) })
  model.traverseVisible((object) => { if (drawable(object)) visible.add(objectIdentity(object)) })
  const fallback: unknown = model.userData.rhinoWireframe
  const count = (key: string): number => {
    const value: unknown = typeof fallback === 'object' && fallback !== null ? Reflect.get(fallback, key) : undefined
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  }
  const layers = readRhinoLayers(model)
  const rawWarnings: unknown = model.userData.warnings
  const warnings = Array.isArray(rawWarnings) ? rawWarnings.map((warning: unknown) => {
    if (typeof warning === 'string') return warning
    return typeof warning === 'object' && warning !== null && 'message' in warning && typeof warning.message === 'string' ? warning.message : ''
  }) : []
  return { objectCount: all.size, visibleObjectCount: visible.size, wireframeCount: count('shown'),
    missingFaceCount: count('missingFaces'), omittedEdgeCount: count('omittedEdges'), omittedObjectCount: count('omittedObjects'), layers, warnings }
}

function objectIdentity(object: Object3D): string {
  const attributes: unknown = object.userData.attributes
  return typeof attributes === 'object' && attributes !== null && 'id' in attributes && typeof attributes.id === 'string' ? attributes.id : object.uuid
}

function drawable(object: Object3D): object is Mesh | Line | Points | Sprite {
  return object instanceof Mesh || object instanceof Line || object instanceof Points || object instanceof Sprite
}

/** @param model - Scene whose visible finite geometry is measured. @returns Bounds, or undefined when no finite geometry is visible. */
export function rhinoBounds(model: Object3D): Box3 | undefined {
  model.updateMatrixWorld(true)
  const bounds = new Box3()
  model.traverseVisible((object) => {
    if (!drawable(object)) return
    const part = new Box3().setFromObject(object)
    if ([...part.min.toArray(), ...part.max.toArray()].every(Number.isFinite)) bounds.union(part)
  })
  return bounds.isEmpty() ? undefined : bounds
}

/** @param model - Decoded model. @param index - File layer index. @param visible - Requested layer visibility. */
export function setRhinoLayerVisible(model: Object3D, index: number, visible: boolean): void {
  changeRhinoLayer(model, index, visible)
}

/**
 * @param camera - Orthographic preview camera.
 * @param bounds - Finite model bounds.
 * @param aspect - Viewport width divided by height.
 * @param direction - Camera direction relative to the model centre.
 * @returns Orbit target.
 */
export function frameRhinoCamera(camera: OrthographicCamera, bounds: Box3, aspect: number, direction: Vector3): Vector3 {
  const center = bounds.getCenter(new Vector3())
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.01)
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfHeight = radius * 1.15 / Math.min(ratio, 1)
  camera.left = -halfHeight * ratio
  camera.right = halfHeight * ratio
  camera.top = halfHeight
  camera.bottom = -halfHeight
  camera.near = radius / 1000
  camera.far = radius * 100
  camera.zoom = 1
  camera.up.set(0, 0, 1)
  camera.position.copy(center).add(direction.clone().normalize().multiplyScalar(radius * 4))
  camera.lookAt(center)
  camera.updateProjectionMatrix()
  return center
}

/** @param model - Retired model or scene. Releases shared resources once, including label textures. */
export function disposeRhinoScene(model: Object3D): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<{ dispose: () => void }>()
  model.traverse((object) => {
    if (!drawable(object)) return
    if ('geometry' in object) geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value)
    }
  })
  for (const texture of textures) texture.dispose()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}
