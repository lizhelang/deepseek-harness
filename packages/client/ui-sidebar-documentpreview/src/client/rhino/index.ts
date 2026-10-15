/** Builtin 3DM previews use the existing authorized complete-file byte reader. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { LazyRhinoBody } from './LazyRhinoBody.tsx'
import type { RhinoLimits } from './types.ts'
import { en, zh } from './locales.ts'

/** Identity shared by 3DM metadata and its keyed document body. */
export const RHINO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/rhino'

/**
 * Describe the built-in renderer for complete binary 3DM files.
 * @param title - Locale-owned renderer name.
 * @returns Complete binary 3DM registration.
 */
export function rhinoBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: RHINO_BODY_ID, extensions: ['3dm'], binaryExtensions: ['3dm'], priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the 3DM renderer and its localized document body for this plugin lifetime.
 * @param ctx - Document and locale registries.
 * @param limits - Resolved parser lifetime limit.
 */
export function apply(ctx: Context, limits: RhinoLimits): void {
  ctx.effect(() => ctx.locale.register('sidebarRhino', { zh, en }))
  const t = ctx.locale.bind('sidebarRhino')
  ctx.effect(() => ctx.documentPreviews.register(rhinoBodyDefinition(() => t('title'))))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: RHINO_BODY_ID, locale: 'sidebarRhino', inject: () => ({ limits }),
  }, LazyRhinoBody)))
}
