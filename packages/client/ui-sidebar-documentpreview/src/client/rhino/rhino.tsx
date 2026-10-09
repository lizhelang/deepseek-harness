/** Read-only Rhino model preview with layer visibility and explicit decoder limitations. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Object3D } from 'three'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseRhino } from './parse.ts'
import { disposeRhinoScene, inspectRhinoScene, type RhinoSceneInfo } from './scene.ts'
import { createRhinoViewport, type RhinoViewport } from './viewport.ts'
import type { RhinoBodyProps } from './types.ts'
import css from './RhinoBody.module.css'

type PreviewState =
  | { readonly kind: 'ready'; readonly data: Uint8Array<ArrayBuffer>; readonly model: Object3D; readonly info: RhinoSceneInfo }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly error: 'invalid' | 'timeout' }

/** @param props - Authorized document bytes, tab lifecycle, dictionary, and limits. @returns Model viewport or a localized failure. */
export function RhinoBody(props: RhinoBodyProps): ReactNode {
  const { content, limits, t } = props
  const { tab } = props.useTabInfo()
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<PreviewState>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!data) return
    const controller = new AbortController()
    const abort = (): void => { controller.abort() }
    tab.signal.addEventListener('abort', abort, { once: true })
    if (tab.signal.aborted) controller.abort()
    let owned: Object3D | undefined
    void Promise.resolve().then(() => parseRhino(data, limits, controller.signal)).then((model) => {
      if (controller.signal.aborted) { disposeRhinoScene(model); return }
      owned = model
      setState({ kind: 'ready', data, model, info: inspectRhinoScene(model) })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState({ kind: 'failed', data, error: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'invalid' })
    })
    return () => { controller.abort(); tab.signal.removeEventListener('abort', abort); if (owned) disposeRhinoScene(owned) }
  }, [data, limits, tab.signal, retry])
  if (!data || !state || state.data !== data) return <div className={css.status} role="status">{t('loading')}</div>
  if (state.kind === 'failed') return <div className={css.status} role="alert">
    <p>{t(state.error)}</p><Button size="sm" onClick={() => { setState(undefined); setRetry(value => value + 1) }}>{t('retry')}</Button>
  </div>
  return <LoadedRhino model={state.model} info={state.info} t={t} />
}

function LoadedRhino({ model, info, t }: { model: Object3D; info: RhinoSceneInfo; t: RhinoBodyProps['t'] }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const viewport = useRef<RhinoViewport>()
  const [unavailable, setUnavailable] = useState(false)
  const [layers, setLayers] = useState(info.layers)
  const [visibleCount, setVisibleCount] = useState(info.visibleObjectCount)
  useEffect(() => {
    const current = inspectRhinoScene(model)
    setLayers(current.layers)
    setVisibleCount(current.visibleObjectCount)
    setUnavailable(false)
    if (!container.current || info.objectCount === 0) return
    try { viewport.current = createRhinoViewport(container.current, model, t('preview')) }
    catch { setUnavailable(true) }
    return () => { viewport.current?.dispose(); viewport.current = undefined }
  }, [model, info, t])
  return <div className={css.body} data-rhino-preview>
    <div className={css.toolbar} aria-label={t('title')}>
      <Button size="sm" variant="toolbar" disabled={unavailable || info.objectCount === 0} onClick={() => { viewport.current?.fit() }}>{t('fit')}</Button>
      <Button size="sm" variant="toolbar" disabled={unavailable || info.objectCount === 0} onClick={() => { viewport.current?.fit('top') }}>{t('top')}</Button>
      <Button size="sm" variant="toolbar" disabled={unavailable || info.objectCount === 0} onClick={() => { viewport.current?.fit('iso') }}>{t('iso')}</Button>
      <span className={css.count}>{t('objects', { count: visibleCount })}</span>
    </div>
    {info.wireframeCount > 0 && <p className={css.wireframe}>{t('wireframe', { count: info.wireframeCount, faces: info.missingFaceCount })}</p>}
    {info.omittedObjectCount > 0 && <p role="status" className={css.wireframe}>{t('omittedObjects', { count: info.omittedObjectCount })}</p>}
    {info.missingFaceCount > 0 && info.wireframeCount === 0 && <p className={css.wireframe}>{t('missingFaces', { count: info.missingFaceCount })}</p>}
    {info.omittedEdgeCount > 0 && <p className={css.wireframe}>{t('omittedEdges', { count: info.omittedEdgeCount })}</p>}
    {info.warnings.length > 0 && <details className={css.warning}>
      <summary>{t('partial', { count: info.warnings.length })}</summary>
      <ul>{info.warnings.filter(Boolean).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}
    {unavailable && <p role="alert" className={css.notice}>{t('unavailable')}</p>}
    {info.objectCount === 0 && <p role="alert" className={css.notice}>{t('empty')}</p>}
    <div className={css.viewport} ref={container} hidden={unavailable || info.objectCount === 0} />
    {layers.length > 0 && <details className={css.layers}>
      <summary>{t('layers')}</summary>
      <div className={css.layerList}>{layers.map(layer => <Checkbox key={layer.index}
        disabled={layer.hiddenByParent} title={layer.hiddenByParent ? t('hiddenByParent') : undefined}
        label={layer.name || t('unnamedLayer', { index: layer.index + 1 })} checked={layer.visible}
        onChange={(visible: boolean) => {
          viewport.current?.layer(layer.index, visible)
          const current = inspectRhinoScene(model)
          setVisibleCount(current.visibleObjectCount)
          setLayers(current.layers)
        }} />)}</div>
    </details>}
    <div className={css.footer}>{t('hint')}<span>{t('readonly')}</span></div>
  </div>
}
