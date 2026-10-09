/** Parser limits and locale-bearing input shared without importing Three.js. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type {} from './locales.ts'

/** Configurable maximum lifetime for one model decode. */
export interface RhinoLimits {
  /** Milliseconds before an unfinished decode is cancelled. */
  readonly timeoutMs: number
}

/** Complete model bytes, document lifecycle, localized controls, and decode limit. */
export type RhinoBodyProps = DocumentPreviewProps & PropsLocale<'sidebarRhino'> & { readonly limits: RhinoLimits }
