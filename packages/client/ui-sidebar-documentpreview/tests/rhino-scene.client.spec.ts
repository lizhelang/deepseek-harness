/** Rhino scene framing uses finite visible geometry and disposes shared GPU objects once. */
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, OrthographicCamera, Texture, Vector3 } from 'three'
import { expect, it, vi } from 'vitest'
import { disposeRhinoScene, frameRhinoCamera, inspectRhinoScene, rhinoBounds, setRhinoLayerVisible } from '../src/client/rhino/scene.ts'

it('keeps layer metadata and decoder warnings beside the rendered object count', () => {
  const model = new Group()
  model.add(new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial()), new Line())
  model.userData.layers = [{ name: 'Bend marks', visible: true, hiddenByParent: false }, { name: 'Source', visible: false, hiddenByParent: false }]
  model.userData.warnings = [{ message: 'Brep has no associated mesh geometry.' }, 'Unsupported annotation']
  expect(inspectRhinoScene(model)).toEqual({ objectCount: 2, visibleObjectCount: 2, wireframeCount: 0,
    missingFaceCount: 0, omittedEdgeCount: 0, omittedObjectCount: 0, layers: [
      { index: 0, name: 'Bend marks', visible: true, hiddenByParent: false }, { index: 1, name: 'Source', visible: false, hiddenByParent: false },
    ], warnings: ['Brep has no associated mesh geometry.', 'Unsupported annotation'] })
  disposeRhinoScene(model)
})

it('fits Z-up geometry including planar contours in narrow and wide viewports', () => {
  const model = new Group()
  const line = new Line(new BufferGeometry().setFromPoints([new Vector3(100, 200, 0), new Vector3(1100, 500, 0)]))
  model.add(line)
  const bounds = rhinoBounds(model)!
  for (const aspect of [0.1, 1, 4, Number.NaN]) {
    const camera = new OrthographicCamera()
    const target = frameRhinoCamera(camera, bounds, aspect, new Vector3(1, -1, 1))
    expect(target.toArray()).toEqual([600, 350, 0])
    expect(camera.up.toArray()).toEqual([0, 0, 1])
    expect([camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far,
      ...camera.position.toArray()].every(Number.isFinite)).toBe(true)
    expect(camera.far).toBeGreaterThan(camera.near)
    camera.updateMatrixWorld()
    for (const point of [bounds.min, bounds.max]) {
      const projected = point.clone().project(camera)
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(1)
    }
  }
  disposeRhinoScene(model)
})

it('ignores hidden and nonfinite geometry when fitting and toggles the requested file layer', () => {
  const model = new Group()
  model.userData.layers = [{}, {}, { visible: true }, { visible: false }]
  const visible = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial())
  visible.userData.attributes = { layerIndex: 2 }
  const hidden = new Mesh(new BoxGeometry(1000, 1000, 1000), new MeshBasicMaterial())
  hidden.visible = false
  hidden.userData.attributes = { layerIndex: 3 }
  model.add(visible, hidden)
  expect(rhinoBounds(model)!.getSize(new Vector3()).toArray()).toEqual([2, 2, 2])
  setRhinoLayerVisible(model, 2, false)
  expect(rhinoBounds(model)).toBeUndefined()
  expect(hidden.visible).toBe(false)
  const bad = new Line(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([NaN, 0, 0], 3)))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  model.add(bad)
  expect(rhinoBounds(model)).toBeUndefined()
  error.mockRestore()
  disposeRhinoScene(model)
})

it('releases shared geometry, materials, and textures once', () => {
  const texture = new Texture()
  const material = new MeshBasicMaterial({ map: texture })
  const geometry = new BoxGeometry()
  const model = new Group()
  model.add(new Mesh(geometry, material), new Mesh(geometry, material), new Line(new BufferGeometry(), new LineBasicMaterial()))
  const release = [vi.spyOn(texture, 'dispose'), vi.spyOn(material, 'dispose'), vi.spyOn(geometry, 'dispose')]
  disposeRhinoScene(model)
  for (const spy of release) expect(spy).toHaveBeenCalledOnce()
})
