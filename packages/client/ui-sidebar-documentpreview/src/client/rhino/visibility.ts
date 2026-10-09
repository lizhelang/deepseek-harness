/** Model-local layer overrides preserve parent layers and source object hiding. */
import type { Object3D } from 'three'

/** One layer's requested and inherited visibility in the current preview. */
export interface RhinoLayer {
  readonly index: number
  readonly name: string
  readonly visible: boolean
  readonly hiddenByParent: boolean
}
interface LayerRecord {
  index: number
  id: string
  parentId: string
  name: string
  visible: boolean
}
const overrides = new WeakMap<Object3D, Map<number, boolean>>()
const sourceVisibility = new WeakMap<Object3D, boolean>()

function layerRecords(model: Object3D): LayerRecord[] {
  const layers: unknown = model.userData.layers
  const values = overrides.get(model)
  return Array.isArray(layers) ? layers.flatMap((layer: unknown, index): LayerRecord[] => {
    if (typeof layer !== 'object' || layer === null) return []
    const text = (key: string): string => { const value: unknown = Reflect.get(layer, key); return typeof value === 'string' ? value : '' }
    return [{ index, id: text('id'), parentId: text('parentLayerId'), name: text('fullPath') || text('name'),
      visible: values?.get(index) ?? (!('visible' in layer) || layer.visible !== false) }]
  }) : []
}

function effectiveLayers(layers: readonly LayerRecord[]): Map<number, boolean> {
  const byId = new Map(layers.filter(layer => layer.id).map(layer => [layer.id, layer]))
  const result = new Map<number, boolean>()
  const active = new Set<number>()
  const visible = (layer: LayerRecord): boolean => {
    const cached = result.get(layer.index)
    if (cached !== undefined) return cached
    if (active.has(layer.index)) return false
    active.add(layer.index)
    const parent = byId.get(layer.parentId)
    const value = layer.visible && (parent === undefined || visible(parent))
    active.delete(layer.index)
    result.set(layer.index, value)
    return value
  }
  layers.forEach(visible)
  return result
}

/** @param model - Decoded model with optional preview layer overrides. @returns Layer labels and inherited hiding. */
export function readRhinoLayers(model: Object3D): readonly RhinoLayer[] {
  const layers = layerRecords(model)
  const effective = effectiveLayers(layers)
  return layers.map(layer => ({ index: layer.index, name: layer.name, visible: layer.visible,
    hiddenByParent: layer.visible && effective.get(layer.index) === false }))
}

/** @param model - Scene whose display visibility is refreshed without changing source attributes. */
export function applyRhinoVisibility(model: Object3D): void {
  const effective = effectiveLayers(layerRecords(model))
  model.traverse((object) => {
    const attributes: unknown = object.userData.attributes
    const layerIndex = typeof attributes === 'object' && attributes !== null && 'layerIndex' in attributes
      && typeof attributes.layerIndex === 'number' ? attributes.layerIndex : undefined
    let original = sourceVisibility.get(object)
    if (original === undefined) {
      original = typeof attributes === 'object' && attributes !== null && 'visible' in attributes && typeof attributes.visible === 'boolean'
        ? attributes.visible : layerIndex === undefined ? object.visible : true
      sourceVisibility.set(object, original)
    }
    object.visible = original && (layerIndex === undefined || effective.get(layerIndex) !== false)
  })
}

/** @param model - Preview model. @param index - File layer index. @param visible - Requested layer visibility. */
export function changeRhinoLayer(model: Object3D, index: number, visible: boolean): void {
  let values = overrides.get(model)
  if (!values) { values = new Map(); overrides.set(model, values) }
  values.set(index, visible)
  applyRhinoVisibility(model)
}
