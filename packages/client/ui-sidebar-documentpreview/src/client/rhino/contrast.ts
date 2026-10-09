/** Preview-only line contrast against the fixed paper background. */
import { Color, Line, LineBasicMaterial, Mesh, Points, Sprite, type Material, type Object3D } from 'three'

/** Paper color shared by the WebGL viewport and line-contrast calculation. */
export const RHINO_PREVIEW_BACKGROUND = 0xf2f4f7

function lineObject(object: Object3D): object is Line { return object instanceof Line }
function otherMaterialObject(object: Object3D): object is Mesh | Points | Sprite {
  return object instanceof Mesh || object instanceof Points || object instanceof Sprite
}

function luminance(color: Color): number {
  // Three.js stores material RGB in linear light, as required by relative luminance.
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/**
 * Darken unreadable line colors proportionally without changing mesh colors or source attributes.
 * @param model - Decoded renderer-owned model.
 * @returns Number of distinct line materials adjusted for the preview.
 */
export function improveRhinoLineContrast(model: Object3D): number {
  const paper = luminance(new Color(RHINO_PREVIEW_BACKGROUND))
  const maximum = (paper + 0.05) / 4.5 - 0.05
  const nonLineMaterials = new Set<Material>()
  model.traverse((object) => {
    if (!otherMaterialObject(object)) return
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) nonLineMaterials.add(material)
  })
  const adjusted = new Map<Material, Material>()
  const inspected = new Set<Material>()
  const readable = (material: Material): Material => {
    const prior = adjusted.get(material)
    if (prior) return prior
    if (inspected.has(material)) return material
    inspected.add(material)
    if (!(material instanceof LineBasicMaterial)) return material
    const light = luminance(material.color)
    if (light <= maximum) return material
    const target = nonLineMaterials.has(material) ? material.clone() : material
    target.color.multiplyScalar(maximum / light)
    adjusted.set(material, target)
    return target
  }
  model.traverse((object) => {
    if (!lineObject(object)) return
    object.material = Array.isArray(object.material) ? object.material.map(readable) : readable(object.material)
  })
  model.userData.rhinoAdjustedLineMaterials = adjusted.size
  return adjusted.size
}
