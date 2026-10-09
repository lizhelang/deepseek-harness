/** Bounded Rhino parsing preserves borrowed bytes and retires late-created workers. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Group, type LoadingManager, type Object3D } from 'three'
let parseRhino: typeof import('../src/client/rhino/parse.ts').parseRhino

vi.mock('../src/client/rhino/wireframe.ts', () => ({ parseRhinoWireframe: vi.fn(async () => ({ objects: [], brepCount: 0, unmeshedBrepCount: 0, unmeshedFaceCount: 0, omittedEdgeCount: 0 })) }))

const state = vi.hoisted(() => ({ instances: [] as FakeLoader[], waitForWorker: false, revoke: vi.fn() }))
class FakeLoader {
  workerSourceURL = ''
  received?: ArrayBuffer
  complete?: (model: Object3D) => void
  fail?: () => void
  readonly dispose = vi.fn()
  readonly worker = { terminate: vi.fn() }
  readonly pending = Promise.withResolvers<Worker>()
  constructor(readonly manager: LoadingManager) { state.instances.push(this) }
  setWorkerLimit() { return this }
  _getWorker(): Promise<Worker> { return this.pending.promise }
  parse(bytes: ArrayBuffer, onLoad: (model: Object3D) => void, onError: () => void) {
    this.received = bytes
    this.complete = onLoad
    this.fail = onError
    if (state.waitForWorker) void this._getWorker().then(() => { onLoad(new Group()) }, onError)
  }
}

beforeEach(async () => {
  vi.doMock('three/addons/loaders/3DMLoader.js', () => ({ Rhino3dmLoader: FakeLoader }))
  parseRhino = (await import('../src/client/rhino/parse.ts')).parseRhino
  state.revoke.mockReset()
  state.instances = []
  state.waitForWorker = false
  vi.stubGlobal('__DSH_RHINO_JS_SOURCE__', 'bundled decoder')
  vi.stubGlobal('__DSH_RHINO_WASM_BASE64__', 'AQID')
  vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:decoder-js').mockReturnValueOnce('blob:decoder-wasm')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(state.revoke)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('three/addons/loaders/3DMLoader.js') })

it('passes an independent transferable buffer and accepts only bundled decoder URLs', async () => {
  const source = new Uint8Array([1, 2, 3])
  const parsed = parseRhino(source, { timeoutMs: 1000 }, new AbortController().signal)
  const loader = state.instances[0]!
  expect(loader.received).not.toBe(source.buffer)
  structuredClone(loader.received, { transfer: [loader.received!] })
  expect([...source]).toEqual([1, 2, 3])
  expect(loader.manager.resolveURL('rhino3dm.js')).toBe('blob:decoder-js')
  expect(loader.manager.resolveURL('rhino3dm.wasm')).toBe('blob:decoder-wasm')
  expect(() => loader.manager.resolveURL('https://example.com/model')).toThrow('Unbundled')
  const model = new Group()
  loader.complete!(model)
  expect(await parsed).toBe(model)
  expect(loader.dispose).toHaveBeenCalled()
  expect(state.revoke).toHaveBeenCalledWith('blob:decoder-js')
  expect(state.revoke).toHaveBeenCalledWith('blob:decoder-wasm')
})

it('ends an invalid decode and an elapsed timeout without a leaked loader', async () => {
  vi.useFakeTimers()
  const failed = parseRhino(new Uint8Array([1]), { timeoutMs: 100 }, new AbortController().signal)
  const expectation = expect(failed).rejects.toThrow('invalid')
  state.instances[0]!.fail!()
  await expectation
  const timed = parseRhino(new Uint8Array([1]), { timeoutMs: 100 }, new AbortController().signal)
  const timedExpectation = expect(timed).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(100)
  await timedExpectation
  expect(state.instances.every(loader => loader.dispose.mock.calls.length > 0)).toBe(true)
})

it('terminates a worker created after an aborted library initialization', async () => {
  state.waitForWorker = true
  const controller = new AbortController()
  const parsed = parseRhino(new Uint8Array([1]), { timeoutMs: 1000 }, controller.signal)
  const rejected = expect(parsed).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  const loader = state.instances[0]!
  loader.workerSourceURL = 'blob:late-worker'
  loader.pending.resolve(loader.worker as Worker)
  await vi.waitFor(() => { expect(loader.worker.terminate).toHaveBeenCalledOnce() })
  expect(state.revoke).toHaveBeenCalledWith('blob:late-worker')
})
