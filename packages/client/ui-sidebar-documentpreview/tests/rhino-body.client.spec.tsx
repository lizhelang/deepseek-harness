// @vitest-environment jsdom
/** Model tabs show decoder limitations and retire stale scene loads when bytes change. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Group, BoxGeometry, Mesh, MeshBasicMaterial, type Object3D } from 'three'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RhinoBody } from '../src/client/rhino/rhino.tsx'
import type { RhinoBodyProps } from '../src/client/rhino/types.ts'
import { en } from '../src/client/rhino/locales.ts'
import { harness } from './fixtures.client.ts'

const calls = vi.hoisted(() => ({ parse: vi.fn(), viewport: vi.fn() }))
vi.mock('../src/client/rhino/parse.ts', () => ({ parseRhino: calls.parse }))
vi.mock('../src/client/rhino/viewport.ts', () => ({ createRhinoViewport: calls.viewport }))

const controls = { fit: vi.fn(), layer: vi.fn(), dispose: vi.fn() }
beforeEach(() => {
  calls.parse.mockReset()
  calls.viewport.mockReset().mockReturnValue(controls)
  Object.values(controls).forEach(call => call.mockReset())
})
afterEach(cleanup)
function props(bytes = new Uint8Array([1])): RhinoBodyProps {
  const h = harness()
  const signal = new AbortController().signal
  return { ...h.props(), content: { kind: 'bytes', data: bytes }, limits: { timeoutMs: 1000 },
    useTabInfo: () => ({ tab: { signal } }), t: makeTranslate(en),
  } as RhinoBodyProps
}
function model() {
  const object = new Group()
  object.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()))
  object.userData.layers = [{ name: 'BEND_90', visible: true }]
  object.userData.warnings = [{ message: 'An annotation is unsupported.' }]
  return object
}

it('shows a usable model, collapsed limitations, standard views, and layer controls', async () => {
  calls.parse.mockResolvedValue(model())
  const view = render(<RhinoBody {...props()} />)
  expect(await screen.findByText('1 geometry objects displayed')).toBeTruthy()
  expect(screen.getByText('Some content cannot be previewed (1 warnings). Surface display requires saved meshes. Check the complete model in Rhino.').closest('details')?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Top' }))
  expect(controls.fit).toHaveBeenCalledWith('top')
  fireEvent.click(screen.getByText('Layers'))
  fireEvent.click(screen.getByRole('checkbox', { name: 'BEND_90' }))
  expect(controls.layer).toHaveBeenCalledWith(0, false)
  view.unmount()
  expect(controls.dispose).toHaveBeenCalledOnce()
})

it('aborts stale input and disposes a late decoded model instead of showing it', async () => {
  const first = Promise.withResolvers<Object3D>()
  const second = Promise.withResolvers<Object3D>()
  calls.parse.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const initial = props()
  const view = render(<RhinoBody {...initial} />)
  await vi.waitFor(() => { expect(calls.parse).toHaveBeenCalledOnce() })
  const signal = calls.parse.mock.calls[0]![2] as AbortSignal
  view.rerender(<RhinoBody {...initial} content={{ kind: 'bytes', data: new Uint8Array([2]) }} />)
  await vi.waitFor(() => { expect(calls.parse).toHaveBeenCalledTimes(2) })
  expect(signal.aborted).toBe(true)
  const stale = model()
  const mesh = stale.children[0] as Mesh
  const disposal = vi.spyOn(mesh.geometry, 'dispose')
  await act(async () => { first.resolve(stale) })
  expect(disposal).toHaveBeenCalledOnce()
  expect(calls.viewport).not.toHaveBeenCalled()
  await act(async () => { second.resolve(model()) })
  expect(calls.viewport).toHaveBeenCalledOnce()
})

it('reports a bounded decode failure and permits retry', async () => {
  calls.parse.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(model())
  render(<RhinoBody {...props()} />)
  expect(await screen.findByText(en.timeout)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('1 geometry objects displayed')).toBeTruthy()
})

it('shows empty and unavailable views instead of a success-looking blank canvas', async () => {
  calls.parse.mockResolvedValueOnce(new Group())
  const view = render(<RhinoBody {...props()} />)
  expect(await screen.findByText(en.empty)).toBeTruthy()
  expect(calls.viewport).not.toHaveBeenCalled()
  view.unmount()
  calls.parse.mockResolvedValueOnce(model())
  calls.viewport.mockImplementationOnce(() => { throw new Error('WebGL unavailable') })
  render(<RhinoBody {...props()} />)
  expect(await screen.findByText(en.unavailable)).toBeTruthy()
})

it('exposes incomplete block surfaces even without an upstream warning', async () => {
  const object = model()
  object.userData.warnings = []
  object.userData.rhinoWireframe = { shown: 0, missingFaces: 2, omittedEdges: 0, omittedObjects: 1 }
  calls.parse.mockResolvedValue(object)
  render(<RhinoBody {...props()} />)
  expect(await screen.findByText('1 unmeshed objects have no edge preview, including objects in block definitions. Check them in Rhino.')).toBeTruthy()
  expect(screen.getByText('2 faces have no display mesh; this preview is incomplete.')).toBeTruthy()
})
