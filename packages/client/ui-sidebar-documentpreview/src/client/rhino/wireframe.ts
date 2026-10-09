/** Isolated read-only fallback for Brep faces without saved display meshes. */

/** One source Brep's finite 3D edges sampled for display, never manufacturing geometry. */
export interface RhinoWireframeObject {
  readonly id: string
  readonly name: string
  readonly layerIndex: number
  readonly visible: boolean
  readonly definitionObject: boolean
  /** Each line contains consecutive xyz coordinates on one finite Brep edge. */
  readonly lines: readonly (readonly number[])[]
}

/** Missing surface meshes remain explicitly counted even when their edges are visible. */
export interface RhinoWireframe {
  readonly objects: readonly RhinoWireframeObject[]
  readonly brepCount: number
  readonly unmeshedBrepCount: number
  readonly unmeshedFaceCount: number
  readonly omittedEdgeCount: number
}

// Raw JavaScript keeps the Worker independent of bundler closure/name transforms.
// Its fixed item caps bound untrusted model expansion, not geometric tolerance.
/** Worker program, shared by browser decoding and official-SDK fixture checks. */
export const rhinoWireframeWorkerSource = String.raw`
self.onmessage = async ({ data }) => {
  let document;
  try {
    const rhino = await rhino3dm({ wasmBinary: data.wasm });
    document = rhino.File3dm.fromByteArray(data.bytes);
    if (!document) throw new Error('invalid');
    const objects = document.objects();
    const result = { objects: [], brepCount: 0, unmeshedBrepCount: 0, unmeshedFaceCount: 0, omittedEdgeCount: 0 };
    let coordinateCount = 0;
    let edgeCount = 0;
    {
      if (objects.count > 10000) throw new Error('tooLarge');
      for (let index = 0; index < objects.count; index++) {
        const object = objects.get(index);
        const geometry = object.geometry();
        try {
          if (geometry.objectType !== rhino.ObjectType.Brep) continue;
          result.brepCount++;
          const faces = geometry.faces();
          let missing = 0;
          try {
            if (faces.count > 10000) throw new Error('tooLarge');
            for (let faceIndex = 0; faceIndex < faces.count; faceIndex++) {
              const face = faces.get(faceIndex);
              try {
                const mesh = face.getMesh(rhino.MeshType.Any);
                if (mesh) {
                  try {
                    const meshFaces = mesh.faces();
                    try { if (meshFaces.count === 0) missing++; }
                    finally { meshFaces.delete(); }
                  } finally { mesh.delete(); }
                } else missing++;
              } finally { face.delete(); }
            }
          } finally { faces.delete(); }
          if (!missing) continue;
          result.unmeshedBrepCount++;
          result.unmeshedFaceCount += missing;
          const attributes = object.attributes();
          let entry;
          try {
            entry = { id: attributes.id, name: attributes.name, layerIndex: attributes.layerIndex,
              visible: attributes.visible, definitionObject: attributes.isInstanceDefinitionObject, lines: [] };
          } finally { attributes.delete(); }
          const edges = geometry.edges();
          try {
            edgeCount += edges.count;
            if (edgeCount > 10000) throw new Error('tooLarge');
            for (let edgeIndex = 0; edgeIndex < edges.count; edgeIndex++) {
              const edge = edges.get(edgeIndex);
              try {
                const domain = edge.domain;
                if (domain.length !== 2 || !domain.every(Number.isFinite) || domain[1] <= domain[0]) {
                  result.omittedEdgeCount++; continue;
                }
                const spans = edge.spanCount;
                if (!Number.isSafeInteger(spans) || spans < 1) { result.omittedEdgeCount++; continue; }
                const steps = edge.isLinear() ? 1 : Math.min(1024, Math.max(128, spans * 32));
                coordinateCount += (steps + 1) * 3;
                if (coordinateCount > 1500000) throw new Error('tooLarge');
                const line = [];
                for (let step = 0; step <= steps; step++) {
                  const point = edge.pointAt(domain[0] + (domain[1] - domain[0]) * (step / steps));
                  if (point.length !== 3 || !point.every(Number.isFinite)) { line.length = 0; break; }
                  line.push(...point);
                }
                if (line.length) entry.lines.push(line);
                else result.omittedEdgeCount++;
              } finally { edge.delete(); }
            }
          } finally { edges.delete(); }
          result.objects.push(entry);
        } finally { geometry.delete(); object.delete(); }
      }
    }
    self.postMessage({ ok: true, value: result });
  } catch (error) {
    self.postMessage({ ok: false, code: error instanceof Error && error.message === 'tooLarge' ? 'tooLarge' : 'invalid' });
  } finally { if (document) document.delete(); }
};
`

/**
 * Decode only unmeshed Brep edges in a disposable Worker using bundled Rhino assets.
 * @param bytes - Borrowed complete model bytes, copied before transfer.
 * @param signal - Document preview lifetime.
 * @param timeoutMs - Maximum decode duration before Worker termination.
 * @returns Display polylines and explicit missing-mesh counts; does not modify the input.
 */
export function parseRhinoWireframe(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal, timeoutMs: number): Promise<RhinoWireframe> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([__DSH_RHINO_JS_SOURCE__, '\n', rhinoWireframeWorkerSource], { type: 'text/javascript' }))
    let worker: Worker
    try { worker = new Worker(url, { name: 'dsh-rhino-edges' }) }
    catch (error) { URL.revokeObjectURL(url); reject(new Error('invalid', { cause: error })); return }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      URL.revokeObjectURL(url)
    }
    const fail = (): void => { finish(); reject(new Error('invalid')) }
    const abort = (): void => { finish(); reject(new DOMException('Rhino preview closed', 'AbortError')) }
    const timer = setTimeout(() => { finish(); reject(new Error('timeout')) }, timeoutMs)
    worker.onerror = fail
    worker.onmessageerror = fail
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (typeof message !== 'object' || message === null || !('ok' in message)) { fail(); return }
      if (message.ok === true && 'value' in message && validWireframe(message.value)) {
        finish(); resolve(message.value)
      } else if (message.ok === false && 'code' in message && message.code === 'tooLarge') {
        finish(); reject(new Error('tooLarge'))
      } else fail()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const copy = bytes.slice()
      const wasm = Uint8Array.from(atob(__DSH_RHINO_WASM_BASE64__), character => character.charCodeAt(0))
      worker.postMessage({ bytes: copy, wasm }, [copy.buffer, wasm.buffer])
    } catch (error) { finish(); reject(new Error('invalid', { cause: error })) }
  })
}

function validWireframe(value: unknown): value is RhinoWireframe {
  if (typeof value !== 'object' || value === null || !('objects' in value) || !Array.isArray(value.objects) || value.objects.length > 10000) return false
  for (const key of ['brepCount', 'unmeshedBrepCount', 'unmeshedFaceCount', 'omittedEdgeCount']) {
    if (!(key in value)) return false
    const count: unknown = Reflect.get(value, key)
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false
  }
  let coordinates = 0
  let edges = 0
  return value.objects.every((object: unknown) => {
    if (typeof object !== 'object' || object === null || !('id' in object) || typeof object.id !== 'string'
      || !('name' in object) || typeof object.name !== 'string' || !('layerIndex' in object) || !Number.isSafeInteger(object.layerIndex)
      || !('visible' in object) || typeof object.visible !== 'boolean' || !('definitionObject' in object) || typeof object.definitionObject !== 'boolean'
      || !('lines' in object) || !Array.isArray(object.lines)) return false
    edges += object.lines.length
    return edges <= 10000 && object.lines.every((line: unknown) => {
      if (!Array.isArray(line) || line.length < 6 || line.length % 3 !== 0 || line.length > 3075) return false
      coordinates += line.length
      return coordinates <= 1500000 && line.every((coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    })
  })
}
