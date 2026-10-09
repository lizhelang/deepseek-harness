/** Attach sampled finite Brep edges while keeping absent surfaces explicitly identified. */
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, type Object3D } from 'three'
import type { RhinoWireframe } from './wireframe.ts'

/** @param model - Official loader scene. @param wireframe - Worker-decoded edges for Breps with missing meshes. */
export function addRhinoWireframes(model: Object3D, wireframe: RhinoWireframe): void {
  let shown = 0
  const layers: unknown = model.userData.layers
  for (const source of wireframe.objects) {
    if (source.definitionObject || source.lines.length === 0) continue
    const group = new Group()
    group.name = source.name
    const layer: unknown = Array.isArray(layers) ? layers[source.layerIndex] : undefined
    group.visible = source.visible && !(typeof layer === 'object' && layer !== null && 'visible' in layer && layer.visible === false)
    const attributes = { id: source.id, layerIndex: source.layerIndex, visible: source.visible }
    group.userData.attributes = attributes
    const material = new LineBasicMaterial({ color: 0x25344a })
    for (const points of source.lines) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
      const line = new Line(geometry, material)
      line.userData.attributes = attributes
      group.add(line)
    }
    model.add(group)
    shown++
  }
  model.userData.rhinoWireframe = { shown, missingFaces: wireframe.unmeshedFaceCount, omittedEdges: wireframe.omittedEdgeCount,
    omittedObjects: wireframe.unmeshedBrepCount - shown }
}
