/** Localized controls and limitations for read-only Rhino previews. */
export const zh = {
  title: '3DM 模型', loading: '正在读取 3DM 模型…',
  invalid: '无法读取此 3DM 文件。请检查文件是否完整。',
  timeout: '模型预览超时，请在 Rhino 中打开检查。',
  unavailable: '当前窗口无法创建 3D 视图，请在 Rhino 中打开。',
  empty: '文件中没有可显示的几何。曲面可能未保存显示网格，请在 Rhino 中打开。',
  fit: '适合窗口', top: '俯视', iso: '轴测', layers: '图层',
  wireframe: '{count} 个曲面模型以边线显示，{faces} 个面缺少显示网格。',
  omittedEdges: '{count} 条边无法预览。',
  omittedObjects: '{count} 个缺网格对象未能补充边线（包括块定义中的对象），请在 Rhino 中核对。',
  missingFaces: '{count} 个面缺少显示网格，当前预览不完整。',
  hiddenByParent: '父图层已隐藏',
  objects: '已显示 {count} 个几何对象',
  partial: '部分内容无法预览（{count} 项）。曲面显示依赖文件内的网格；请用 Rhino 核对完整模型。',
  hint: '拖动旋转 · 右键拖动平移 · 滚轮缩放',
  readonly: '只读预览，不修改模型', preview: 'Rhino 模型预览',
  unnamedLayer: '未命名图层 {index}', retry: '重试',
} satisfies Record<string, string>

/** Rhino preview dictionary keys. */
export type RhinoPreviewKey = keyof typeof zh

/** English Rhino preview controls and limitations. */
export const en = {
  title: '3DM model', loading: 'Reading 3DM model…',
  invalid: 'This 3DM file could not be read. Check that the file is complete.',
  timeout: 'Model preview timed out. Open the file in Rhino to inspect it.',
  unavailable: 'This window cannot create a 3D view. Open the file in Rhino.',
  empty: 'This file contains no displayable geometry. Surfaces may lack saved display meshes. Open it in Rhino.',
  fit: 'Fit', top: 'Top', iso: 'Isometric', layers: 'Layers',
  wireframe: '{count} surface objects shown as edge lines; {faces} faces have no display mesh.',
  omittedEdges: '{count} edges could not be previewed.',
  omittedObjects: '{count} unmeshed objects have no edge preview, including objects in block definitions. Check them in Rhino.',
  missingFaces: '{count} faces have no display mesh; this preview is incomplete.',
  hiddenByParent: 'Hidden by a parent layer',
  objects: '{count} geometry objects displayed',
  partial: 'Some content cannot be previewed ({count} warnings). Surface display requires saved meshes. Check the complete model in Rhino.',
  hint: 'Drag to orbit · Right-drag to pan · Scroll to zoom',
  readonly: 'Read-only preview; model files remain unchanged', preview: 'Rhino model preview',
  unnamedLayer: 'Unnamed layer {index}', retry: 'Retry',
} satisfies Record<RhinoPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Rhino preview labels. */
    sidebarRhino: RhinoPreviewKey
  }
}
