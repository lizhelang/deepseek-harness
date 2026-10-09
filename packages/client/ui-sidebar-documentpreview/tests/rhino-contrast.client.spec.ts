/** Preview line colors remain readable on paper without changing source or mesh appearance. */
import { BoxGeometry, BufferGeometry, Color, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial } from 'three'
import { expect, it } from 'vitest'
import { improveRhinoLineContrast, RHINO_PREVIEW_BACKGROUND } from '../src/client/rhino/contrast.ts'
import { disposeRhinoScene } from '../src/client/rhino/scene.ts'

function light(color: Color) { return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b }

it('darkens white lines to readable gray while keeping black and saturated blue unchanged', () => {
  const model = new Group()
  const white = new LineBasicMaterial({ color: 0xffffff })
  const black = new LineBasicMaterial({ color: 0x000000 })
  const blue = new LineBasicMaterial({ color: 0x0000ff })
  for (const material of [white, black, blue]) model.add(new Line(new BufferGeometry(), material))
  const source = { drawColor: { r: 255, g: 255, b: 255 } }
  model.children[0]!.userData.attributes = source
  expect(improveRhinoLineContrast(model)).toBe(1)
  expect((light(new Color(RHINO_PREVIEW_BACKGROUND)) + 0.05) / (light(white.color) + 0.05)).toBeCloseTo(4.5)
  expect(white.color.r).toBe(white.color.g)
  expect(white.color.g).toBe(white.color.b)
  expect(black.color.getHex()).toBe(0x000000)
  expect(blue.color.getHex()).toBe(0x0000ff)
  expect(source).toEqual({ drawColor: { r: 255, g: 255, b: 255 } })
  disposeRhinoScene(model)
})

it('preserves a light blue hue and processes shared line material only once', () => {
  const model = new Group()
  const material = new LineBasicMaterial({ color: 0x87cefa })
  const original = material.color.clone()
  model.add(new Line(new BufferGeometry(), material), new Line(new BufferGeometry(), material))
  expect(improveRhinoLineContrast(model)).toBe(1)
  expect(material.color.r / original.r).toBeCloseTo(material.color.g / original.g)
  expect(material.color.g / original.g).toBeCloseTo(material.color.b / original.b)
  expect((light(new Color(RHINO_PREVIEW_BACKGROUND)) + 0.05) / (light(material.color) + 0.05)).toBeCloseTo(4.5)
  disposeRhinoScene(model)
})

it('leaves mesh colors intact even when a mesh shares the original line material', () => {
  const model = new Group()
  const shared = new LineBasicMaterial({ color: 0xffffff })
  const line = new Line(new BufferGeometry(), shared)
  const mesh = new Mesh(new BoxGeometry(), shared)
  const other = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0xffffff }))
  model.add(line, mesh, other)
  expect(improveRhinoLineContrast(model)).toBe(1)
  expect(line.material).not.toBe(shared)
  expect(mesh.material).toBe(shared)
  expect(shared.color.getHex()).toBe(0xffffff)
  expect(other.material.color.getHex()).toBe(0xffffff)
  disposeRhinoScene(model)
})
