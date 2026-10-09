/** The binary 3DM renderer installs and disposes through the document extension seam. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { DocumentPreviewRegistry, binaryDocumentPath } from '../src/client/document/registry.ts'
import { apply, RHINO_BODY_ID, rhinoBodyDefinition } from '../src/client/rhino/index.ts'
import { LazyRhinoBody } from '../src/client/rhino/LazyRhinoBody.tsx'
import { en, zh } from '../src/client/rhino/locales.ts'

it('recognizes mixed-case 3DM files without offering plain text fallback', () => {
  const definition = rhinoBodyDefinition(() => 'Rhino')
  expect(definition).toMatchObject({ extensions: ['3dm'], loading: 'bytes-complete', wrap: false })
  expect(binaryDocumentPath([definition], 'model.3DM')).toBe(true)
})

it('registers its locale, metadata, lazy body, and resolved timeout with complete disposal', async () => {
  const ctx = new Context()
  const registry = new DocumentPreviewRegistry()
  const dictionaries = new Map<string, unknown>()
  const bodies = new Map<string, unknown>()
  const limits = { timeoutMs: 10_000 }
  const register = vi.fn((options: { key: string }, body: unknown) => {
    bodies.set(options.key, body)
    return () => { bodies.delete(options.key) }
  })
  ctx.provide('documentPreviews', registry)
  ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
  ctx.provide('locale', {
    bind: () => (key: keyof typeof en) => en[key],
    register: (name: string, value: unknown) => { dictionaries.set(name, value); return () => { dictionaries.delete(name) } },
  } as never)
  const fiber = ctx.plugin({ apply: (context) => { apply(context, limits) } })
  try {
    await fiber.await()
    expect(registry.candidates('MODEL.3DM')[0]?.id).toBe(RHINO_BODY_ID)
    expect(registry.candidates('MODEL.3DM')[0]?.title()).toBe(en.title)
    expect(dictionaries.get('sidebarRhino')).toEqual({ zh, en })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'sidebar.right.tab.document', key: RHINO_BODY_ID, locale: 'sidebarRhino' }), LazyRhinoBody)
  } finally { await fiber.dispose() }
  expect(registry.getSnapshot()).toEqual([])
  expect(dictionaries.size).toBe(0)
  expect(bodies.size).toBe(0)
})
