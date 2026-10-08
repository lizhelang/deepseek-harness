/** Typed future-node editor and the unbound Session's explicit start form. */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductionGraph, ProductionNode, ProductionPortType } from '@deepseek-ai/dsh-production-studio/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { StudioViewProps } from './slots.ts'
import { edgePath, graphFindings, newNode, portPoint, PORT_TYPES } from './graph-editor.ts'
import type { StudioGoalDraft } from './stores.ts'
import css from './Studio.module.css'

type LocalStyle = CSSProperties & { '--studio-x'?: string; '--studio-y'?: string; '--studio-zoom'?: number }
type Wire = { node: string; port: string }
type Drag =
  | { kind: 'node'; id: string; clientX: number; clientY: number; x: number; y: number }
  | { kind: 'pan'; clientX: number; clientY: number; x: number; y: number }
  | { kind: 'wire'; clientX: number; clientY: number }

function PortTypePicker({ value, onChange, t }: PropsLocale<'productionStudio'> & { value: ProductionPortType; onChange: (value: ProductionPortType) => void }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => { setOpen(false) }} autoFocus
    items={PORT_TYPES.map(type => ({ id: type, label: t(`port.${type}`) }))}
    onSelect={(id) => { const type = PORT_TYPES.find(item => item === id); if (type !== undefined) onChange(type); setOpen(false) }}
    anchor={<Button size="sm" variant="outline" aria-label={t('field.portType')} aria-expanded={open} onClick={() => { setOpen(!open) }}>{t(`port.${value}`)}</Button>} />
}

function JsonField({ label, value, raw, update, writeRaw, t }: PropsLocale<'productionStudio'> & { label: string; value: JsonValue | undefined; raw: string | undefined; update: (value: JsonValue) => void; writeRaw: (value: string) => void }) {
  const draft = raw ?? JSON.stringify(value ?? {}, null, 2)
  let invalid = false
  try { JSON.parse(draft) }
  catch (_error) { invalid = true /* Unfinished JSON remains visible until the user repairs it. */ }
  return <label className={css.field}>{label}
    <textarea rows={3} aria-label={label} value={draft} aria-invalid={invalid} onChange={(event) => {
      const text = event.target.value; writeRaw(text)
      try { const parsed = JSON.parse(text) as JsonValue; update(parsed) }
      catch (_error) { /* The draft store retains invalid input without replacing the last parsed node settings. */ }
    }} />
    {invalid && <span className={css.error}>{t('start.invalidJson')}</span>}
  </label>
}

function NodeInspector({ node, update, remove, tools, jsonFields, writeJson, locked, removeLocked, conversation, maxAttempts, t }: PropsLocale<'productionStudio'> & {
  node: ProductionNode
  update: (node: ProductionNode) => void
  remove: () => void
  tools: readonly string[]
  jsonFields: Readonly<Record<string, string>>
  writeJson: (field: string, value: string) => void
  locked: boolean
  removeLocked: boolean
  conversation: boolean
  maxAttempts: number
}) {
  const setConfig = (config: ProductionNode['config']): void => { update({ ...node, config: { ...node.config, ...config } }) }
  const requiredGate = node.protected === true && node.kind === 'gate' && node.config.certification !== undefined
  const successOutput = node.outputs.find(port => port.outlet === 'success')
  const text = (key: 'prompt' | 'provider' | 'model' | 'toolName' | 'evidencePath' | 'evidenceToolName' | 'question' | 'reconcileToolName', label: string, multiline = false) =>
    <label className={css.field}>{label}{multiline
      ? <textarea aria-label={label} rows={3} value={node.config[key] ?? ''} onChange={(event) => { setConfig({ [key]: event.target.value }) }} />
      : <Input aria-label={label} value={node.config[key] ?? ''} readOnly={(conversation && (key === 'provider' || key === 'model')) || (requiredGate && ['toolName', 'evidencePath', 'evidenceToolName', 'reconcileToolName'].includes(key))}
        onChange={(event) => { if (!conversation || (key !== 'provider' && key !== 'model')) setConfig({ [key]: event.target.value }) }} />}</label>
  return <section className={css.inspector} data-production-inspector={node.id}>
    <div className={css.toolbar}><h3>{node.label}</h3><span className={css.muted}>{t(`node.${node.kind}`)}</span>
      <Button size="sm" variant="ghost" disabled={node.protected || removeLocked} title={removeLocked ? t('editor.locked') : node.protected ? t('editor.protected') : undefined} onClick={remove}>{t('editor.delete')}</Button></div>
    {node.protected && <p className={css.muted}>{t('editor.protected')}</p>}
    {locked && <p className={css.muted}>{t('editor.locked')}</p>}
    {conversation && node.kind === 'agent' && <p className={css.muted}>{t('editor.modelUnsupported')}</p>}
    <fieldset className={css.inspectorFields} disabled={locked}>
      <div className={css.fields}>
        <label className={css.field}>{t('field.label')}<Input aria-label={t('field.label')} value={node.label} onChange={(event) => { update({ ...node, label: event.target.value }) }} /></label>
        <label className={css.field}>{t('field.attempts')}<Input type="number" min={1} max={maxAttempts}
          aria-label={t('field.attempts')} value={node.maxAttempts}
          onChange={(event) => {
            update({ ...node, maxAttempts: Math.max(1, Math.min(maxAttempts, Number(event.target.value) || 1)) })
          }} /></label>
        <label className={css.field}>{t('field.resource')}<Input aria-label={t('field.resource')} value={node.resource ?? ''} onChange={(event) => { update({ ...node, resource: event.target.value }) }} /></label>
        {!node.protected && node.inputs[0] !== undefined && <div className={css.field}>{t('field.inputType')}
          <PortTypePicker value={node.inputs[0].type} t={t} onChange={(type) => { update({ ...node,
            inputs: node.inputs.map(port => ({ ...port, type })),
            outputs: node.kind === 'gate' || node.kind === 'human' ? node.outputs.map(port => port.outlet === 'success' ? { ...port, type } : port) : node.outputs,
          }) }} /></div>}
        {!node.protected && (node.kind === 'agent' || node.kind === 'program') && successOutput !== undefined && <div className={css.field}>{t('field.outputType')}
          <PortTypePicker value={successOutput.type} t={t} onChange={(type) => { update({ ...node,
            outputs: node.outputs.map(port => port.outlet === 'success' ? { ...port, type } : port),
          }) }} /></div>}
        {node.kind === 'agent' && <>
          {text('provider', t('field.provider'))}{text('model', t('field.model'))}
          <label className={css.field}>{t('field.tools')}<textarea aria-label={t('field.tools')} rows={2} value={(node.config.tools ?? []).join('\n')}
            onChange={(event) => { setConfig({ tools: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) }) }} /></label>
        </>}
        {(node.kind === 'agent' || node.kind === 'program') && text('prompt', t('field.role'), true)}
        {(node.kind === 'gate' || node.kind === 'program') && <>
          {text('toolName', t('field.tool'))}
          {requiredGate ? <div className={css.field}>{t('field.arguments')}<pre>{JSON.stringify(node.config.arguments ?? {}, null, 2)}</pre></div>
            : <JsonField key={`${node.id}:arguments`} label={t('field.arguments')} value={node.config.arguments} raw={jsonFields[`${node.id}:arguments`]} t={t} writeRaw={(value) => { writeJson(`${node.id}:arguments`, value) }} update={(value) => { setConfig({ arguments: value }) }} />}
          {text('reconcileToolName', t('branch.reconcile'))}
        </>}
        {node.kind === 'gate' && <>
          {text('evidencePath', t('field.evidence'))}
          {text('evidenceToolName', t('field.evidenceSource'))}
          {requiredGate ? <div className={css.field}>{t('field.expected')}<pre>{JSON.stringify(node.config.expected ?? true, null, 2)}</pre></div>
            : <JsonField key={`${node.id}:expected`} label={t('field.expected')} value={node.config.expected} raw={jsonFields[`${node.id}:expected`]} t={t} writeRaw={(value) => { writeJson(`${node.id}:expected`, value) }} update={(value) => { setConfig({ expected: value }) }} />}
          {node.config.certification !== undefined && <div className={css.field}>{t('field.certification')}<strong>{t(`certificate.${node.config.certification}`)}</strong></div>}
        </>}
        {(node.kind === 'gate' || node.kind === 'delivery') && <label className={css.field}>{t('field.files')}
          <textarea aria-label={t('field.files')} rows={2} value={(node.config.filePaths ?? []).join('\n')} readOnly={requiredGate}
            onChange={(event) => { setConfig({ filePaths: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) }) }} /></label>}
        {(node.kind === 'gate' || node.kind === 'delivery') && <label className={css.field}>{t('field.hashes')}
          <textarea aria-label={t('field.hashes')} rows={2} value={(node.config.fileHashes ?? []).join('\n')} readOnly={requiredGate}
            onChange={(event) => { setConfig({ fileHashes: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) }) }} /></label>}
        {node.kind === 'human' && text('question', t('field.question'), true)}
      </div>
      {node.kind !== 'human' && node.kind !== 'delivery' && <div className={css.rowActions}>
        <Checkbox label={t('field.before')} checked={node.config.breakBefore ?? false} onChange={(value) => { setConfig({ breakBefore: value }) }} />
        <Checkbox label={t('field.after')} checked={node.config.breakAfter ?? false} onChange={(value) => { setConfig({ breakAfter: value }) }} />
      </div>}
    </fieldset>
    {tools.length > 0 && <details className={css.history}><summary>{t('field.tools')}</summary><pre>{tools.join('\n')}</pre></details>}
  </section>
}

/**
 * Render the actual editable graph, preserving unsent fields across Host updates.
 * @param props - Typed Remote mutation callbacks, Session draft and locale props.
 * @returns the canonical graph, live node phases and supported future edits.
 */
export function ProductionWorkflowView(props: StudioViewProps) {
  const { useProduction, useStore, actions, t, saveGraph, start, refresh } = props
  const read = useProduction(value => value)
  const drafts = useStore(value => value)
  const snapshot = read.snapshot
  const conversation = snapshot?.capabilities.conversation !== undefined
  const currentRun = conversation ? snapshot.runs.findLast(run => run.mode === 'conversation' && run.phase !== 'complete')
    ?? snapshot.runs.findLast(run => run.mode === 'conversation' && run.graph.version === snapshot.graph.version) : undefined
  const tasks = new Map(currentRun?.tasks.map(task => [task.nodeId, task]))
  const graph = drafts.dirty ? drafts.graph ?? snapshot?.graph : snapshot?.graph
  const baseVersion = drafts.dirty ? drafts.baseVersion ?? snapshot?.graph.version ?? 0 : snapshot?.graph.version ?? 0
  const lockedNode = (id: string): boolean => {
    const task = tasks.get(id)
    return task !== undefined && (task.admitted === true || task.attempts > 0
      || ['running', 'human', 'paused', 'complete', 'unknown'].includes(task.phase))
  }
  // Removing a future target would also remove a consumed predecessor's route.
  const lockedRemoval = (id: string): boolean => lockedNode(id)
    || graph?.edges.some(edge => edge.toNode === id && lockedNode(edge.fromNode)) === true
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [wire, setWire] = useState<Wire | null>(null)
  const [ghost, setGhost] = useState({ x: 0, y: 0 })
  const [view, setView] = useState({ x: 20, y: 20, zoom: 0.8 })
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [recoveryVisible, setRecoveryVisible] = useState(true)
  const invalidFields = Object.entries(drafts.jsonFields).filter(([field, value]) => {
    if (!graph?.nodes.some(node => field.startsWith(`${node.id}:`))) return false
    try { JSON.parse(value); return false }
    catch (_error) { return true /* Validation reports unfinished property input without discarding it. */ }
  })
  const pendingRef = useRef(false)
  const drag = useRef<Drag | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const fitted = useRef(false)
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    if (snapshot !== null && !drafts.dirty && drafts.baseVersion !== snapshot.graph.version) actions.loaded(snapshot.graph)
  }, [snapshot, drafts.dirty, drafts.baseVersion, actions])
  const change = (next: ProductionGraph): void => { actions.graph(next, baseVersion); setMessage(null) }
  const updateNode = (node: ProductionNode): void => {
    if (graph !== undefined && !lockedNode(node.id)) change({ ...graph, nodes: graph.nodes.map(item => item.id === node.id ? node : item) })
  }
  const moveNode = (id: string, x: number, y: number): void => {
    if (graph !== undefined) change({ ...graph, nodes: graph.nodes.map(node => node.id === id ? { ...node, x, y } : node) })
  }
  const point = (clientX: number, clientY: number): { x: number; y: number } => {
    const bounds = canvas.current?.getBoundingClientRect()
    const current = viewRef.current
    return { x: (clientX - (bounds?.left ?? 0) - current.x) / current.zoom, y: (clientY - (bounds?.top ?? 0) - current.y) / current.zoom }
  }
  const connect = (nodeId: string, portId: string): void => {
    if (graph === undefined || wire === null) return
    if (lockedNode(wire.node)) { setWire(null); return }
    const output = graph.nodes.find(node => node.id === wire.node)?.outputs.find(port => port.id === wire.port)
    const input = graph.nodes.find(node => node.id === nodeId)?.inputs.find(port => port.id === portId)
    if (wire.node === nodeId) { setMessage(t('editor.selfEdge')); setWire(null); return }
    if (output?.type !== input?.type) { setMessage(t('editor.portMismatch')); setWire(null); return }
    if (graph.edges.some(edge => edge.fromNode === wire.node && edge.fromPort === wire.port
      && edge.toNode === nodeId && edge.toPort === portId)) { setWire(null); return }
    let index = 1
    while (graph.edges.some(edge => edge.id === `edge-${index}`)) index++
    change({ ...graph, edges: [...graph.edges, { id: `edge-${index}`, fromNode: wire.node, fromPort: wire.port, toNode: nodeId, toPort: portId }] })
    setWire(null)
  }
  const capture = (event: PointerEvent, value: Drag): void => {
    event.preventDefault(); event.stopPropagation(); drag.current = value
    canvas.current?.setPointerCapture(event.pointerId)
  }
  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (wire !== null) setGhost(point(event.clientX, event.clientY))
    if (current === null) return
    if (current.kind === 'pan') setView({ ...viewRef.current, x: current.x + event.clientX - current.clientX, y: current.y + event.clientY - current.clientY })
    if (current.kind === 'node') {
      const node = graph?.nodes.find(item => item.id === current.id)
      if (node !== undefined) moveNode(node.id,
        Math.max(0, current.x + (event.clientX - current.clientX) / viewRef.current.zoom),
        Math.max(0, current.y + (event.clientY - current.clientY) / viewRef.current.zoom))
    }
  }
  const onUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    drag.current = null
    if (canvas.current?.hasPointerCapture(event.pointerId)) canvas.current.releasePointerCapture(event.pointerId)
    if (current?.kind === 'wire' && Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 4) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-studio-input]')
      if (target?.dataset.node !== undefined && target.dataset.port !== undefined) connect(target.dataset.node, target.dataset.port)
      else setWire(null)
    }
  }
  const fit = (): void => {
    if (graph === undefined || canvas.current === null || graph.nodes.length === 0) return
    const width = Math.max(...graph.nodes.map(node => node.x + 266))
    const height = Math.max(...graph.nodes.map(node => node.y + 210))
    const zoom = Math.max(0.2, Math.min(1, (canvas.current.clientWidth - 36) / width, (canvas.current.clientHeight - 36) / height))
    setView({ x: Math.max(18, (canvas.current.clientWidth - width * zoom) / 2), y: 18, zoom })
  }
  useEffect(() => {
    if (!fitted.current && graph !== undefined && canvas.current !== null) { fitted.current = true; fit() }
  }, [graph])
  useEffect(() => {
    const element = canvas.current
    if (element === null) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) setView(current => ({
        ...current,
        zoom: Math.max(0.2, Math.min(2, current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))),
      }))
      else setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel) }
  }, [graph !== undefined])
  const findings = graph === undefined ? [] : graphFindings(graph)
  const findingText = (): string => findings.map((finding) => {
    switch (finding.kind) {
      case 'endpoint': return t('editor.edgeMissing')
      case 'mismatch': return t('editor.portMismatch')
      case 'self': return t('editor.selfEdge')
      case 'disconnected': return t('editor.disconnected', { node: finding.node ?? '' })
      case 'delivery': return t('editor.deliveryMissing')
      case 'gate': return t('editor.gateMissing', { gate: finding.gate === undefined ? '' : t(`certificate.${finding.gate}`) })
    }
  }).join('\n')
  const perform = async (operation: () => Promise<string | null>, success: string): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true; setPending(true); setMessage(null)
    try { const error = await operation(); setMessage(error ?? success) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const handleSave = (): void => {
    if (graph === undefined) return
    if (invalidFields.length > 0) { setMessage(t('editor.invalidFields')); return }
    if (findings.length > 0) { setMessage(findingText()); return }
    const submitted = graph
    void perform(async () => {
      const error = await saveGraph(baseVersion, submitted)
      if (error === null) actions.loaded({ ...submitted, version: baseVersion + 1 })
      return error
    }, t('editor.saved'))
  }
  const handleStart = (): void => {
    if (graph === undefined || conversation) return
    if (invalidFields.length > 0) { setMessage(t('editor.invalidFields')); return }
    if (drafts.dirty) { setMessage(t('editor.unsavedStart')); return }
    if (drafts.objective.trim() === '') { setMessage(t('start.objectiveRequired')); return }
    if (!drafts.goalAcknowledged) { setMessage(t('start.goalIncomplete')); return }
    let input: JsonValue
    try { input = JSON.parse(drafts.input) as JsonValue }
    catch (_error) { setMessage(t('start.invalidJson')); return }
    if (input === null || Array.isArray(input) || typeof input !== 'object') { setMessage(t('start.inputObject')); return }
    const deliveryGoal: Record<string, JsonValue> = { kind: 'verified-drawings', objectiveText: drafts.objective.trim() }
    for (const field of Object.keys(drafts.goal) as (keyof StudioGoalDraft)[]) {
      const value = drafts.goal[field]
      if (value.trim() === '') continue
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < (field === 'maxPieces' ? 1 : 0) || (field !== 'maxManufacturingScore' && !Number.isInteger(numeric))) { setMessage(t('start.goalInvalid')); return }
      deliveryGoal[field] = numeric
    }
    if (findings.length > 0) { setMessage(findingText()); return }
    const requestInput = { ...input, deliveryGoal }
    void perform(() => start({ graphVersion: baseVersion, objective: drafts.objective.trim(), input: requestInput, goalContractAcknowledged: true }), t('run.active'))
  }
  if (graph === undefined || snapshot === null) return <div className={css.empty}><p>{read.loading ? t('loading') : read.error ?? t('unavailable')}</p>
    {!read.loading && <Button size="sm" onClick={refresh}>{t('refresh')}</Button>}</div>
  const activeNode = graph.nodes.find(node => node.id === selected)
  const activeEdge = graph.edges.find(edge => edge.id === selectedEdge)
  const wireNode = wire === null ? undefined : graph.nodes.find(node => node.id === wire.node)
  const conflict = drafts.dirty && snapshot.graph.version !== baseVersion
  return <section className={css.editor} data-production-editor>
    <div className={css.toolbar}><h2>{t('view.editor')}</h2><span className={css.muted}>{t(conversation && !drafts.dirty ? 'task.versionLive' : 'editor.draft', { version: baseVersion })}</span>
      <span className={css.muted}>{drafts.dirty ? t('editor.changed') : ''}</span>
      <Button size="sm" variant="primary" disabled={pending || !drafts.dirty} onClick={handleSave}>{t('editor.save')}</Button></div>
    <p className={css.muted}>{t(conversation ? 'editor.future' : 'editor.frozen')}</p>
    {conversation && <p className={css.muted}>{t('conversation.autoStart')}</p>}
    {conflict && <div className={css.error} role="alert">{t('editor.conflict')}<Button size="sm" variant="outline" onClick={() => { actions.loaded(snapshot.graph); setMessage(null) }}>{t('editor.reload')}</Button></div>}
    {read.error !== null && <p className={css.error} role="alert">{read.error}</p>}
    <div className={css.toolbar}>
      {(['agent', 'gate', 'human'] as const).map(kind => <Button key={kind} size="sm" variant="outline" disabled={conversation && kind === 'agent'} title={conversation && kind === 'agent' ? t('editor.agentUnsupported') : undefined} onClick={() => {
        const node = newNode(graph, kind, t(kind === 'agent' ? 'node.newAgent' : kind === 'gate' ? 'node.newGate' : 'node.newHuman'))
        change({ ...graph, nodes: [...graph.nodes, node] }); setSelected(node.id); setSelectedEdge(null)
      }}>{t(kind === 'agent' ? 'editor.addAgent' : kind === 'gate' ? 'editor.addGate' : 'editor.addHuman')}</Button>)}
      <Button size="sm" variant="ghost" onClick={fit}>{t('editor.fit')}</Button>
      <Button size="sm" variant="ghost" aria-label={t('editor.zoomOut')} onClick={() => { setView(current => ({ ...current, zoom: Math.max(0.2, current.zoom / 1.2) })) }}>−</Button>
      <span className={css.muted}>{Math.round(view.zoom * 100)}{'%'}</span>
      <Button size="sm" variant="ghost" aria-label={t('editor.zoomIn')} onClick={() => { setView(current => ({ ...current, zoom: Math.min(2, current.zoom * 1.2) })) }}>+</Button>
      <Button size="sm" variant="outline" onClick={() => { setMessage(findings.length > 0 ? findingText() : t('editor.valid')) }}>{t('editor.check')}</Button>
    </div>
    <p className={css.muted}>{t('editor.canvasHelp')}</p>
    <div ref={canvas} className={css.canvas} role="group" aria-label={t('editor.canvas')} data-production-canvas
      onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target instanceof SVGElement && event.target.tagName === 'svg')) {
        setSelected(null); setSelectedEdge(null); setWire(null)
        capture(event, { kind: 'pan', clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y })
      } }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; setWire(null) }}>
      <div className={css.world} style={{ '--studio-x': `${view.x}px`, '--studio-y': `${view.y}px`, '--studio-zoom': view.zoom } as LocalStyle}>
        <svg className={css.wires} width={4000} height={4000} aria-hidden="true">
          {graph.edges.map((edge) => {
            const from = graph.nodes.find(node => node.id === edge.fromNode)
            const to = graph.nodes.find(node => node.id === edge.toNode)
            if (from === undefined || to === undefined) return null
            const outlet = from.outputs.find(port => port.id === edge.fromPort)?.outlet
            if (!recoveryVisible && outlet !== 'success') return null
            const path = edgePath(portPoint(from, edge.fromPort, true), portPoint(to, edge.toPort, false))
            return <g key={edge.id} data-production-edge={edge.id}>
              <path d={path} className={clsx(css.wire, outlet !== 'success' && css.recoveryWire, selectedEdge === edge.id && css.selectedWire)} />
              <path d={path} className={css.wireHit} onClick={(event) => {
                event.stopPropagation(); setSelectedEdge(edge.id); setSelected(null)
              }} />
            </g>
          })}
          {wire !== null && wireNode !== undefined && <path className={clsx(css.wire, css.selectedWire)}
            d={edgePath(portPoint(wireNode, wire.port, true), ghost)} />}
        </svg>
        {graph.nodes.map((node) => {
          const task = tasks.get(node.id)
          return <article key={node.id} className={clsx(css.node, selected === node.id && css.selectedNode)}
            data-production-node={node.id} data-phase={task?.phase} style={{ '--studio-x': `${node.x}px`, '--studio-y': `${node.y}px` } as LocalStyle} onClick={() => { setSelected(node.id); setSelectedEdge(null) }}>
            <button type="button" className={css.nodeTitle} onPointerDown={(event) => {
              setSelected(node.id); setSelectedEdge(null)
              capture(event, { kind: 'node', id: node.id, clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y })
            }}>{node.label}</button>
            <div className={css.nodeKind}>{t(`node.${node.kind}`)}
              {task !== undefined && <span className={css.phase} data-phase={task.phase}>{' · '}{t(`phase.${task.phase}`)}</span>}
              {node.protected ? ' · ' + t('editor.protected') : ''}</div>
            <div className={css.ports}>
              <div>{node.inputs.map(port => <button key={port.id} type="button" className={css.inputPort} data-studio-input data-node={node.id} data-port={port.id}
                aria-label={t('editor.connectTo', { node: node.label, port: port.id })} onClick={(event) => { event.stopPropagation(); connect(node.id, port.id) }}>
                <span className={css.portDot} />{t(`port.${port.type}`)}</button>)}</div>
              <div>{node.outputs.map(port => <button key={port.id} type="button" disabled={lockedNode(node.id)} className={css.outputPort} data-studio-output data-node={node.id} data-port={port.id}
                data-outlet={port.outlet} aria-label={t('editor.connectFrom', { node: node.label, port: port.id })}
                onPointerDown={(event) => {
                  if (lockedNode(node.id)) return
                  setWire({ node: node.id, port: port.id }); setGhost(portPoint(node, port.id, true))
                  capture(event, { kind: 'wire', clientX: event.clientX, clientY: event.clientY })
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  if (lockedNode(node.id)) return
                  setWire({ node: node.id, port: port.id }); setGhost(portPoint(node, port.id, true))
                }}>
                {port.outlet === undefined ? t(`port.${port.type}`) : t(`outlet.${port.outlet}`)}<span className={css.portDot} /></button>)}</div>
            </div>
            <div className={css.nodeBudget}>{t('field.attempts')}{': '}{node.maxAttempts}{node.resource ? ' · ' + node.resource : ''}</div>
          </article>})}
      </div>
    </div>
    <Checkbox label={t('editor.recovery')} checked={recoveryVisible} onChange={setRecoveryVisible} />
    {activeEdge !== undefined && <div className={css.toolbar}>
      <span>{t('editor.connection', { from: activeEdge.fromNode, to: activeEdge.toNode })}</span>
      <Button size="sm" variant="outline" disabled={lockedNode(activeEdge.fromNode)} onClick={() => {
        if (lockedNode(activeEdge.fromNode)) return
        change({ ...graph, edges: graph.edges.filter(edge => edge.id !== activeEdge.id) }); setSelectedEdge(null)
      }}>{t('editor.deleteEdge')}</Button>
    </div>}
    {message !== null && <p className={css.feedback} role="status">{message}</p>}
    {activeNode === undefined ? <p className={css.muted}>{t('editor.select')}</p> : <NodeInspector key={activeNode.id} node={activeNode} t={t} tools={snapshot.capabilities.tools}
      locked={lockedNode(activeNode.id)} removeLocked={lockedRemoval(activeNode.id)} conversation={conversation}
      maxAttempts={conversation ? snapshot.graph.nodes.find(node => node.id === activeNode.id)?.maxAttempts ?? activeNode.maxAttempts : 100}
      update={updateNode} jsonFields={drafts.jsonFields} writeJson={actions.json} remove={() => {
        if (activeNode.protected || lockedRemoval(activeNode.id)) return
        change({
          ...graph,
          nodes: graph.nodes.filter(node => node.id !== activeNode.id),
          edges: graph.edges.filter(edge => edge.fromNode !== activeNode.id && edge.toNode !== activeNode.id),
        }); setSelected(null)
      }} />}
    <div className={css.fields}>
      <label className={css.field}>{t('field.executions')}<Input type="number" min={1} max={conversation ? snapshot.graph.maxExecutions : 1000} aria-label={t('field.executions')} value={graph.maxExecutions}
        onChange={(event) => {
          change({ ...graph,
            maxExecutions: Math.max(1, Math.min(conversation ? snapshot.graph.maxExecutions : 1000, Number(event.target.value) || 1)),
          })
        }} /></label>
      <label className={css.field}>{t('field.concurrent')}<Input type="number" min={1} max={conversation ? snapshot.graph.maxConcurrent : 16} aria-label={t('field.concurrent')} value={graph.maxConcurrent}
        onChange={(event) => {
          change({ ...graph,
            maxConcurrent: Math.max(1, Math.min(conversation ? snapshot.graph.maxConcurrent : 16, Number(event.target.value) || 1)),
          })
        }} /></label>
    </div>
    {!conversation && <section className={css.start}>
      <h3>{t('start.title')}</h3>
      <label className={css.field}>{t('start.objective')}<Input aria-label={t('start.objective')} placeholder={t('start.objectivePlaceholder')} value={drafts.objective}
        onChange={(event) => { actions.objective(event.target.value) }} /></label>
      <div className={css.field}>{t('start.goalKind')}<strong>{t('start.goalDrawings')}</strong></div>
      <div className={css.fields}>
        {(['maxPieces', 'maxWeldActions', 'maxBendActions', 'maxManufacturingScore'] as const satisfies readonly (keyof StudioGoalDraft)[]).map(field =>
          <label key={field} className={css.field}>{t(`start.${field}`)}<Input type="number" min={field === 'maxPieces' ? 1 : 0} step={field === 'maxManufacturingScore' ? 'any' : 1}
            aria-label={t(`start.${field}`)} value={drafts.goal[field]} onChange={(event) => { actions.goal(field, event.target.value) }} /></label>)}
      </div>
      <p className={css.muted}>{t('start.goalHint')}</p>
      <p className={css.muted}>{t('start.goalScope')}</p>
      <Checkbox label={t('start.goalAcknowledged')} checked={drafts.goalAcknowledged} onChange={actions.goalAcknowledged} />
      <label className={css.field}>{t('start.input')}<textarea rows={4} aria-label={t('start.input')} value={drafts.input} onChange={(event) => { actions.input(event.target.value) }} /></label>
      <p className={css.muted}>{t('start.inputHint')}</p>
      <p className={css.muted}>{t('capabilities', { agents: t(snapshot.capabilities.subagent ? 'capability.agent' : 'capability.noAgent'), tools: snapshot.capabilities.tools.length, files: t(snapshot.capabilities.filesystem ? 'capability.files' : 'capability.noFiles') })}</p>
      <div className={css.toolbar}><Button size="sm" variant="primary" disabled={pending} onClick={handleStart}>{pending ? t('action.pending') : t('start.action')}</Button><span className={css.muted}>{t('start.cost')}</span></div>
    </section>}
  </section>
}
