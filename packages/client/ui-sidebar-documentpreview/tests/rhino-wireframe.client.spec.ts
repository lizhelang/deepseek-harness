/** Fallback lifecycle and finite trimmed-edge behavior with the official decoder. */
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRhinoWireframe, rhinoWireframeWorkerSource, type RhinoWireframe } from '../src/client/rhino/wireframe.ts'

class ParserWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn<(message: { bytes: Uint8Array<ArrayBuffer>; wasm: Uint8Array<ArrayBuffer> }, transfer: Transferable[]) => void>()
  terminate = vi.fn()
}

const preview = {
  objects: [{ id: 'object', name: 'Panel', layerIndex: 0, visible: true, definitionObject: false, lines: [[1, 2, 3, 4, 5, 6]] }],
  brepCount: 1, unmeshedBrepCount: 1, unmeshedFaceCount: 1, omittedEdgeCount: 0,
}
let instance: ParserWorker
const revokeUrl = vi.fn()

beforeEach(() => {
  vi.stubGlobal('__DSH_RHINO_JS_SOURCE__', '')
  vi.stubGlobal('__DSH_RHINO_WASM_BASE64__', 'AA==')
  vi.stubGlobal('Worker', vi.fn(function () { instance = new ParserWorker(); return instance }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rhino-edges')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); revokeUrl.mockClear() })

it('copies retained bytes and releases the Worker, callbacks, and URL', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const result = parseRhinoWireframe(bytes, new AbortController().signal, 1000)
  const [message, transfer] = instance.postMessage.mock.calls[0]!
  expect(message.bytes).toEqual(bytes)
  expect(message.bytes).not.toBe(bytes)
  expect(transfer).toEqual([message.bytes.buffer, message.wasm.buffer])
  instance.onmessage!({ data: { ok: true, value: preview } })
  await expect(result).resolves.toEqual(preview)
  expect(instance.terminate).toHaveBeenCalledOnce()
  expect(instance.onmessage).toBeNull()
  expect(revokeUrl).toHaveBeenCalledWith('blob:rhino-edges')
})

it('does not allocate for an already aborted document', () => {
  expect(() => parseRhinoWireframe(new Uint8Array(), AbortSignal.abort(), 1000)).toThrow()
  expect(Worker).not.toHaveBeenCalled()
})

it('terminates the Worker when the document closes', async () => {
  const controller = new AbortController()
  const result = parseRhinoWireframe(new Uint8Array(), controller.signal, 1000)
  controller.abort()
  await expect(result).rejects.toThrow('closed')
  expect(instance.terminate).toHaveBeenCalledOnce()
})

it('bounds decoder lifetime even when no message arrives', async () => {
  vi.useFakeTimers()
  const result = parseRhinoWireframe(new Uint8Array(), new AbortController().signal, 25)
  const rejection = expect(result).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(25)
  await rejection
  expect(instance.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([null, {}, { ok: false, code: 'invalid' }, { ok: true, value: null },
  { ok: true, value: { ...preview, unmeshedFaceCount: -1 } },
  { ok: true, value: { ...preview, objects: [{ ...preview.objects[0], lines: [[0, 0, 0, 1, Infinity, 0]] }] } },
  { ok: true, value: { ...preview, objects: [{ ...preview.objects[0], lines: [[0, 0, 0]] }] } },
])('rejects invalid Worker output %j', async (data) => {
  const result = parseRhinoWireframe(new Uint8Array(), new AbortController().signal, 1000)
  instance.onmessage!({ data })
  await expect(result).rejects.toThrow('invalid')
  expect(instance.terminate).toHaveBeenCalledOnce()
})

it('reports expansion limits rather than a successful partial model', async () => {
  const result = parseRhinoWireframe(new Uint8Array(), new AbortController().signal, 1000)
  instance.onmessage!({ data: { ok: false, code: 'tooLarge' } })
  await expect(result).rejects.toThrow('tooLarge')
})

it.each(['onerror', 'onmessageerror'] as const)('releases the Worker after %s', async (event) => {
  const result = parseRhinoWireframe(new Uint8Array(), new AbortController().signal, 1000)
  instance[event]!()
  await expect(result).rejects.toThrow('invalid')
  expect(instance.terminate).toHaveBeenCalledOnce()
})

it('revokes the URL when Worker creation fails', async () => {
  vi.stubGlobal('Worker', vi.fn(function () { throw new Error('unavailable') }))
  await expect(parseRhinoWireframe(new Uint8Array(), new AbortController().signal, 1000)).rejects.toThrow('invalid')
  expect(revokeUrl).toHaveBeenCalledOnce()
})

it('terminates the Worker when buffer transfer fails', async () => {
  vi.stubGlobal('Worker', vi.fn(function () {
    instance = new ParserWorker()
    instance.postMessage.mockImplementation(() => { throw new Error('unavailable') })
    return instance
  }))
  await expect(parseRhinoWireframe(new Uint8Array(), new AbortController().signal, 1000)).rejects.toThrow('invalid')
  expect(instance.terminate).toHaveBeenCalledOnce()
})

describe('finite source edge sampling', () => {
  it('samples the edge domain, not the underlying curve extent or endpoint chord', async () => {
    const deleted = vi.fn()
    const edge = { domain: [2, 4], spanCount: 1, isLinear: () => false,
      pointAt: vi.fn((parameter: number) => [parameter, Math.sin(parameter), 0]), delete: deleted }
    const collection = (items: readonly object[]) => ({ count: items.length, get: (index: number) => items[index], delete: deleted })
    const geometry = { objectType: 16, faces: () => collection([{ getMesh: () => null, delete: deleted }]),
      edges: () => collection([edge]), delete: deleted }
    const attributes = { id: 'object', name: 'Curve', layerIndex: 0, visible: true, isInstanceDefinitionObject: false, delete: deleted }
    const document = {
      objects: () => collection([{ geometry: () => geometry, attributes: () => attributes, delete: deleted }]), delete: deleted,
    }
    const rhino = { File3dm: { fromByteArray: () => document }, ObjectType: { Brep: 16 }, MeshType: { Any: 0 } }
    const worker = { onmessage: async (_event: { data: object }) => {}, postMessage: vi.fn() }
    // Runs the same standalone program that the browser executes in its Worker.
    runInNewContext(rhinoWireframeWorkerSource, { rhino3dm: async () => rhino, self: worker })
    await worker.onmessage({ data: { bytes: new Uint8Array(), wasm: new Uint8Array() } })
    expect(edge.pointAt).toHaveBeenCalledTimes(129)
    expect(edge.pointAt.mock.calls[0]).toEqual([2])
    expect(edge.pointAt.mock.calls.at(-1)).toEqual([4])
    expect(worker.postMessage).toHaveBeenCalledWith({ ok: true, value: {
      ...preview, objects: [{ ...preview.objects[0], name: 'Curve', lines: [Array.from({ length: 129 }, (_, index) => {
        const parameter = 2 + index / 64
        return [parameter, Math.sin(parameter), 0]
      }).flat()] }],
    } })
    expect(document.delete).toHaveBeenCalled()
  })
})


it('reads an actual 3DM Brep with the official SDK and retains its curved finite edge', async () => {
  const createRhino = createRequire(import.meta.url)('rhino3dm') as typeof import('rhino3dm').default
  const rhino = await createRhino()
  const document = new rhino.File3dm()
  const sphere = new rhino.Sphere([0, 0, 0], 2)
  const brep = rhino.Brep.createFromSphere(sphere)
  const attributes = new rhino.ObjectAttributes()
  attributes.name = 'Unmeshed sphere'
  document.objects().addBrep(brep, attributes)
  const messages: { ok: boolean; value?: RhinoWireframe; code?: string }[] = []
  const worker = { onmessage: async (_event: { data: object }) => {},
    postMessage: (message: { ok: boolean; value?: RhinoWireframe; code?: string }) => { messages.push(message) } }
  try {
    runInNewContext(rhinoWireframeWorkerSource, { rhino3dm: async () => rhino, self: worker })
    await worker.onmessage({ data: { bytes: document.toByteArray() } })
    expect(messages[0]).toMatchObject({ ok: true, value: {
      brepCount: 1, unmeshedBrepCount: 1, unmeshedFaceCount: 1, omittedEdgeCount: 0,
    } })
    const object = messages[0]!.value!.objects[0]!
    expect(object.name).toBe('Unmeshed sphere')
    expect(object.lines).toHaveLength(1)
    expect(object.lines[0]!.length).toBeGreaterThan(6)
    for (let index = 0; index < object.lines[0]!.length; index += 3) {
      expect(Math.hypot(...object.lines[0]!.slice(index, index + 3))).toBeCloseTo(2, 10)
    }
  } finally {
    // Embind's generic release is present at runtime but absent from upstream declarations.
    for (const object of [attributes, brep, sphere, document]) {
      const release = Reflect.get(object, 'delete') as () => void
      release.call(object)
    }
  }
})
