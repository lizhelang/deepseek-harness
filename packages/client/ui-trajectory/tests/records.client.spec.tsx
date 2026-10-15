// @vitest-environment jsdom
/** Business records stay event-owned without affecting model-message timing. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ConversationLocation, ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TrajectoryEventNode, TrajectoryRecordNode } from '../src/client/trajectory-contract.ts'
import { appendTrajectoryPartialLayout, deriveTrajectoryLayout } from '../src/client/layout.ts'
import { deriveTrajectoryTimeline } from '../src/client/timeline.ts'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import { t } from './locale.client.ts'

const data = Object.freeze({ phase: 'unknown', revision: 9 })
function record(seq: number, time: number): TrajectoryRecordNode<typeof data> {
  return { kind: 'record', type: 'example/checkpoint', seq, time, data,
    format: value => ({ label: 'Workflow progress', text: value.phase, inputDetail: JSON.stringify(value) }) }
}
const layout = (nodes: readonly TrajectoryEventNode[], eventLocations?: ReadonlyMap<number, ConversationLocation>) =>
  deriveTrajectoryLayout({ nodes, ...(eventLocations === undefined ? {} : { eventLocations }), partial: null, runningCalls: [] }, t)
const rows = (nodes: readonly TrajectoryEventNode[]) =>
  layout(nodes).flatMap(turn => turn.groups.flatMap(group => group.cells))

afterEach(cleanup)

describe('Trajectory business records', () => {
  it.each([false, true])('preserves steering before its request anchor with an early checkpoint (trailing=%s)', (trailing) => {
    const steering: ConversationNode = { kind: 'steering', messageId: MessageId('steer-1'), seq: 3, time: 3_000,
      content: [{ type: 'text', text: 'change direction' }], source: null }
    const source = { getSnapshot: () => undefined, subscribe: () => () => {} }
    const locationData = { get: () => undefined, source: () => source }
    const step = { turn: 1, step: 2, start: undefined, end: undefined, status: 'open' as const, data: locationData }
    const turn = { turn: 1, start: undefined, end: undefined, status: 'open' as const, steps: [step], data: locationData }
    const eventLocations = new Map<number, ConversationLocation>([
      [1, { kind: 'session' }], [3, { kind: 'step', turn, step }],
    ])
    const requests = [{ purpose: 'assistant' as const, startSeq: 2, turn: 1, step: 2,
      startedAt: 2_000, completedAt: null, status: 'running' as const }]
    const derive = (nodes: readonly TrajectoryEventNode[]) => deriveTrajectoryLayout({
      nodes, eventLocations, requests, partial: null, runningCalls: [],
    }, t).flatMap(section => section.groups.flatMap(group => group.cells))
    const original = derive([steering])
    const combined = derive([record(1, 1_000), steering, ...(trailing ? [record(4, 4_000)] : [])])
    expect(original.map(cell => cell.sourceSeq)).toEqual([3, 2])
    expect(combined.map(cell => cell.sourceSeq)).toEqual(trailing ? [1, 3, 2, 4] : [1, 3, 2])
    const business = combined.filter(cell => cell.kind !== 'record')
    expect(business.map(({ index: _index, ...cell }) => cell)).toEqual(original.map(({ index: _index, ...cell }) => cell))
  })

  it('preserves every original cell except its display index across standalone insertion positions', () => {
    const user: ConversationNode = { kind: 'user', seq: 10, time: 10_000, content: [], source: null }
    const steering: ConversationNode = { kind: 'steering', messageId: MessageId('steer-1'), seq: 30, time: 30_000,
      content: [{ type: 'text', text: 'change direction' }], source: null }
    const source = { getSnapshot: () => undefined, subscribe: () => () => {} }
    const locationData = { get: () => undefined, source: () => source }
    const step = { turn: 1, step: 2, start: undefined, end: undefined, status: 'open' as const, data: locationData }
    const turn = { turn: 1, start: undefined, end: undefined, status: 'open' as const, steps: [step], data: locationData }
    const eventLocations = new Map<number, ConversationLocation>([[30, { kind: 'step', turn, step }]])
    const requests = [{ purpose: 'assistant' as const, startSeq: 20, turn: 1, step: 2,
      startedAt: 20_000, completedAt: null, status: 'running' as const }]
    const derive = (nodes: readonly TrajectoryEventNode[]) => deriveTrajectoryLayout({
      nodes, eventLocations, requests, partial: null, runningCalls: [],
    }, t)
    const original = derive([user, steering]).flatMap(section => section.groups.flatMap(group => group.cells))
    expect(original.map(cell => cell.sourceSeq)).toEqual([10, 30, 20])
    for (const positions of [[1], [15], [25], [40], [1, 15, 25, 40]]) {
      const combined = derive([user, steering, ...positions.map(seq => record(seq, seq * 1_000))])
      const cells = combined.flatMap(section => section.groups.flatMap(group => group.cells))
      expect(cells.filter(cell => cell.kind !== 'record').map(({ index: _index, ...cell }) => cell))
        .toEqual(original.map(({ index: _index, ...cell }) => cell))
      expect(cells.filter(cell => cell.kind === 'record').map(cell => cell.sourceSeq)).toEqual(positions)
      expect(combined.filter(section => section.turn !== null)
        .flatMap(section => section.groups.flatMap(group => group.cells)).every(cell => cell.kind !== 'record')).toBe(true)
    }
  })

  it.each(['unresolved', 'session'] as const)('interleaves a %s checkpoint with both sides of the same turn', (kind) => {
    const user: ConversationNode = { kind: 'user', seq: 1, time: 1_000, content: [], source: null }
    const assistant: ConversationNode = { kind: 'assistant', seq: 3, time: 6_000, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'reply' }] }
    const checkpoint = record(2, 4_000)
    const eventLocations = new Map<number, ConversationLocation>([[2, { kind }]])
    const mixed = layout([user, checkpoint, assistant], eventLocations)
    expect(mixed.map(section => section.turn)).toEqual([1, null, 1])
    const cells = mixed.flatMap(section => section.groups.flatMap(group => group.cells))
    expect(cells.map(cell => cell.sourceSeq)).toEqual([1, 2, 3])
    expect(cells[1]?.recordId).toBe(rows([checkpoint])[0]?.recordId)
    expect(cells[2]?.timeSeconds).toBe(5)
    const overview = deriveTrajectoryTimeline(mixed)
    expect(overview?.spans.map(span => span.index)).toEqual([1, 2, 3])
    expect(overview?.turnBoundaries).toEqual([{ turn: 1, time: 0 }])
    expect(deriveTrajectoryTimeline(mixed, 'actual')?.turnBoundaries).toHaveLength(1)
    const { container } = render(<TrajectoryTable turns={mixed} t={t} renderSlot={() => null} loadImage={async () => { throw new Error('Record fixture contains no image attachments') }}
      collapsedTurns={new Set()} onToggleTurn={() => {}}
      collapsedAssistants={new Set()} onToggleAssistant={() => {}} />)
    expect(Array.from(container.querySelectorAll('tr[data-trajectory-row-key]'), row => row.getAttribute('data-record-index')))
      .toEqual(['1', '2', '3'])
  })

  it('keeps partial replies after the last checkpoint, including a trailing standalone record', () => {
    const user: ConversationNode = { kind: 'user', seq: 1, time: 1_000, content: [], source: null }
    const assistant: ConversationNode = { kind: 'assistant', seq: 3, time: 6_000, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'reply' }] }
    const partial = { turn: 1, step: 2, blocks: [{ kind: 'text' as const, text: 'streaming' }] }
    for (const nodes of [[user, record(2, 4_000), assistant], [user, assistant, record(4, 7_000)]]) {
      const base = layout(nodes)
      const lastIndex = Math.max(...base.flatMap(section => section.groups.flatMap(group => group.cells.map(cell => cell.index))))
      const updated = appendTrajectoryPartialLayout(base, partial, lastIndex, t)
      const cells = updated.flatMap(section => section.groups.flatMap(group => group.cells))
      expect(cells.map(cell => cell.index)).toEqual([1, 2, 3, 4])
      expect(cells.at(-1)?.previewMarkdown).toBe('streaming')
      expect(updated.filter(section => section.turn === null)).toEqual(base.filter(section => section.turn === null))
    }
  })

  it('renders an independent tail with a stable identity after prepend and append', () => {
    const node = record(9, 9_000)
    const tail = layout([node])
    expect(tail).toMatchObject([{ turn: null, groups: [{ title: 'Records', cells: [{
      kind: 'record', kindLabel: 'Workflow progress', sourceSeq: 9,
      inputDetail: JSON.stringify(data), timeSeconds: 0, startedAt: 9_000,
    }] }] }])
    const original = rows([node])[0]!
    const replayed = rows([record(4, 4_000), node, record(12, 12_000)])
    expect(replayed.map(cell => cell.sourceSeq)).toEqual([4, 9, 12])
    expect(replayed[1]?.recordId).toBe(original.recordId)
    expect(replayed[1]?.inputDetail).toBe(original.inputDetail)
    expect(node.data).toBe(data)
    expect(deriveTrajectoryTimeline(tail, 'actual')?.spans[0]).toMatchObject({
      kind: 'record', start: 9_000, end: 9_000,
    })
  })

  it('uses the event location without fabricating a turn or step', () => {
    const source = { getSnapshot: () => undefined, subscribe: () => () => {} }
    const locationData = { get: () => undefined, source: () => source }
    const step = { turn: 3, step: 2, start: undefined, end: undefined, status: 'open' as const, data: locationData }
    const turn = { turn: 3, start: undefined, end: undefined, status: 'open' as const, steps: [step], data: locationData }
    const eventLocations = new Map<number, ConversationLocation>([
      [4, { kind: 'turn', turn }], [9, { kind: 'step', turn, step }],
    ])
    expect(layout([record(4, 4_000), record(9, 9_000)], eventLocations)).toMatchObject([{
      turn: 3, groups: [{ title: 'Message', cells: [{ sourceSeq: 4 }] }, { title: 'Step 2', cells: [{ sourceSeq: 9 }] }],
    }])
  })

  it('reformats event-owned data with current copy without changing historical payload', () => {
    let label = 'Workflow progress'
    const node: TrajectoryRecordNode<typeof data> = { ...record(9, 9_000),
      format: value => ({ label, text: value.phase, inputDetail: JSON.stringify(value) }) }
    const before = rows([node])[0]!
    label = '流程进度'
    const after = rows([node])[0]!
    expect(after.kindLabel).toBe('流程进度')
    expect(after.recordId).toBe(before.recordId)
    expect(after.inputDetail).toBe(before.inputDetail)
  })

  it('does not advance the model-duration cursor or alter recorded model metrics', () => {
    const user: ConversationNode = { kind: 'user', seq: 1, time: 1_000, content: [], source: null }
    const assistant: ConversationNode = { kind: 'assistant', seq: 3, time: 6_000, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'reply' }], usage: { inputTokens: 10, outputTokens: 20 } }
    const before = rows([user, assistant]).find(cell => cell.kind === 'message')!
    const after = rows([user, record(2, 4_000), assistant]).find(cell => cell.kind === 'message')!
    expect(before.timeSeconds).toBe(5)
    expect(after.timeSeconds).toBe(before.timeSeconds)
    expect(after.assistantMetrics).toEqual(before.assistantMetrics)
    expect([after.input, after.output, after.think]).toEqual([before.input, before.output, before.think])
  })
})
