/** Layer display respects source object hiding, parent chains, and cyclic metadata. */
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three'
import { expect, it } from 'vitest'
import { applyRhinoVisibility, changeRhinoLayer, readRhinoLayers } from '../src/client/rhino/visibility.ts'
import { inspectRhinoScene, disposeRhinoScene } from '../src/client/rhino/scene.ts'
import { addRhinoWireframes } from '../src/client/rhino/wireframe-scene.ts'

function fixture() {
  const model = new Group()
  const layers: { id: string; parentLayerId?: string; name: string; visible: boolean }[] = [
    { id: 'parent', name: 'Parent', visible: false },
    { id: 'child', parentLayerId: 'parent', name: 'Child', visible: true },
    { id: 'other', name: 'Other', visible: true },
  ]
  model.userData.layers = layers
  const child = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  child.userData.attributes = { id: 'child-object', layerIndex: 1, visible: true }
  const hidden = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  hidden.userData.attributes = { id: 'hidden-object', layerIndex: 1, visible: false }
  const other = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  other.userData.attributes = { id: 'other-object', layerIndex: 2, visible: true }
  model.add(child, hidden, other)
  return { model, child, hidden, other, layers }
}

it('applies parent hiding initially and preserves explicitly hidden objects after layer toggles', () => {
  const { model, child, hidden, other, layers } = fixture()
  applyRhinoVisibility(model)
  expect([child.visible, hidden.visible, other.visible]).toEqual([false, false, true])
  expect(readRhinoLayers(model)[1]).toMatchObject({ visible: true, hiddenByParent: true })
  changeRhinoLayer(model, 0, true)
  expect([child.visible, hidden.visible, other.visible]).toEqual([true, false, true])
  changeRhinoLayer(model, 1, false)
  changeRhinoLayer(model, 1, true)
  expect(hidden.visible).toBe(false)
  changeRhinoLayer(model, 0, false)
  expect(child.visible).toBe(false)
  expect(other.visible).toBe(true)
  expect(layers[0]!.visible).toBe(false)
  disposeRhinoScene(model)
})

it('keeps cyclic layer chains hidden instead of recursing indefinitely', () => {
  const { model, child, layers } = fixture()
  layers[0] = { id: 'parent', parentLayerId: 'child', name: 'Parent', visible: true }
  applyRhinoVisibility(model)
  expect(child.visible).toBe(false)
  expect(readRhinoLayers(model).slice(0, 2).every(layer => layer.hiddenByParent)).toBe(true)
  changeRhinoLayer(model, 1, true)
  expect(child.visible).toBe(false)
  disposeRhinoScene(model)
})

it('reports unplaced block-definition edge omissions even when upstream produced no warning', () => {
  const { model } = fixture()
  addRhinoWireframes(model, { objects: [{ id: 'block', name: 'Block', layerIndex: 1, visible: true,
    definitionObject: true, lines: [[0, 0, 0, 10, 0, 0]] }],
  brepCount: 1, unmeshedBrepCount: 1, unmeshedFaceCount: 2, omittedEdgeCount: 0 })
  expect(inspectRhinoScene(model)).toMatchObject({ omittedObjectCount: 1, missingFaceCount: 2, wireframeCount: 0, warnings: [] })
  disposeRhinoScene(model)
})
