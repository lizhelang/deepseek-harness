/** Keep the Rhino decoder and Three.js outside the initial document-preview bundle. */
import { lazy, Suspense, type ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type { RhinoBodyProps } from './types.ts'

const LoadedRhinoBody = lazy(async () => ({ default: (await import('./rhino.tsx')).RhinoBody }))

/** @param props - Complete model bytes and localized document seats. @returns Deferred 3D preview. */
export function LazyRhinoBody(props: RhinoBodyProps): ReactNode {
  return <Suspense fallback={<LoadingIndicator label={props.t('loading')} />}>
    <LoadedRhinoBody {...props} />
  </Suspense>
}
