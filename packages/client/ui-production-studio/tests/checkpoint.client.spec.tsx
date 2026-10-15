// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ChatSnapshot, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TrajectorySnapshot } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { chatViewDefinition } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { trajectoryViewDefinition } from '../../ui-trajectory/src/client/trajectory-snapshot-builder.ts'
import { deriveTrajectoryLayout } from '../../ui-trajectory/src/client/layout.ts'
import { TrajectoryTable } from '../../ui-trajectory/src/client/TrajectoryTable.tsx'
import { t as trajectoryT } from '../../ui-trajectory/tests/locale.client.ts'
import { productionChatDefinition, productionTrajectoryDefinition } from '../src/client/checkpoint.ts'
import { ProductionCheckpointView } from '../src/client/ProductionCheckpoint.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import { run } from './fixtures.ts'

afterEach(cleanup)
const t: TranslateNS<'productionStudio'> = makeTranslate(en, commonEn)
const trajectoryDefinition = productionTrajectoryDefinition(t)

function checkpoint(seq: number, phase: 'running' | 'complete' | 'unknown'): SessionLiveEventEntry {
  const current = { ...run('same-workpiece', phase), mode: 'conversation' as const, revision: seq,
    binding: { provider: 'aea', key: '/original-slanted.3dm' } }
  current.history = [{ nodeId: 'baseline', attempt: 1, phase, message: `Actual ${phase} transition`, time: seq }]
  return { type: 'event', event: { type: 'production/checkpoint', seq: SessionSeq(seq), time: seq, ignorable: true, data: { run: current } } }
}

function replay(entries: SessionLiveEventEntry[] = [], hasMore = false) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [productionChatDefinition, trajectoryDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition, trajectoryViewDefinition] },
  )
  assembler.replaceWindow(entries, hasMore)
  assembler.activateTarget('chat'); assembler.activateTarget('trajectory')
  const chat = (): ChatNode<'production-checkpoint'>[] => {
    assembler.flush()
    return (assembler.snapshot('chat') as ChatSnapshot).nodes.values().filter((node): node is ChatNode<'production-checkpoint'> => node.kind === 'production-checkpoint')
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
  }
  const trajectory = (): TrajectorySnapshot => { assembler.flush(); return assembler.snapshot('trajectory') as TrajectorySnapshot }
  return { assembler, chat, trajectory }
}

describe('committed production checkpoint replay', () => {
  it('renders a tail checkpoint independently and preserves older checkpoints after prepend and append', () => {
    const first = checkpoint(4, 'running'), second = checkpoint(9, 'unknown'), third = checkpoint(12, 'complete')
    const live = replay([second], true)
    const originalKey = live.chat()[0]?.key
    expect(live.chat()[0]?.data.run.tasks[0]?.phase).toBe('unknown')
    live.assembler.prepend([first], false)
    expect(live.chat()[1]?.key).toBe(originalKey)
    live.assembler.append(third)
    const complete = replay([first, second, third])
    expect(live.chat()).toEqual(complete.chat())
    expect(live.trajectory()).toEqual(complete.trajectory())
    expect(live.chat().map(node => ({
      seq: node.anchorSeq, run: node.data.run.id, revision: node.data.run.revision, phase: node.data.run.tasks[0]?.phase,
    })))
      .toMatchInlineSnapshot(`
        [
          {
            "phase": "running",
            "revision": 4,
            "run": "same-workpiece",
            "seq": 4,
          },
          {
            "phase": "unknown",
            "revision": 9,
            "run": "same-workpiece",
            "seq": 9,
          },
          {
            "phase": "complete",
            "revision": 12,
            "run": "same-workpiece",
            "seq": 12,
          },
        ]
      `)
    expect(live.trajectory().eventNodes.map(node => node.kind === 'record' ? [node.seq, node.type, node.data] : node))
      .toEqual([first, second, third].map(entry => [entry.event.seq, 'production/checkpoint', { seq: entry.event.seq, time: entry.event.time, ...entry.event.data }]))
    const snapshot = live.trajectory()
    const layout = deriveTrajectoryLayout({ ...snapshot, nodes: snapshot.eventNodes }, trajectoryT)
    const rows = layout.flatMap(turn => turn.groups.flatMap(group => group.cells))
    expect(rows.map(row => [row.kind, row.sourceSeq, row.kindLabel])).toEqual([
      ['record', 4, 'Workflow progress'], ['record', 9, 'Workflow progress'], ['record', 12, 'Workflow progress'],
    ])
    expect(rows.map(row => row.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('Actual running transition'), expect.stringContaining('Actual unknown transition'), expect.stringContaining('Actual complete transition'),
    ]))
  })
  it('renders the committed transition and source binding without reading live task state', () => {
    const h = replay([checkpoint(4, 'running')])
    const node = h.chat()[0]!
    const { container } = render(<ProductionCheckpointView {...{ node, t } as Omit<ChatNodeViewProps<'production-checkpoint'>, 't'> & { t: typeof t }} />)
    expect(screen.getByText('Workflow progress')).toBeTruthy()
    expect(screen.getByText('Workpiece same-workpiece')).toBeTruthy()
    expect(screen.getByText('baseline · Running · Actual running transition')).toBeTruthy()
    expect(screen.getByText('Source: aea · /original-slanted.3dm')).toBeTruthy()
    h.assembler.append(checkpoint(9, 'unknown'))
    expect(container.querySelector('[data-production-checkpoint="4"]')).toBeTruthy()
    expect(screen.queryByText('Actual unknown transition')).toBeNull()
  })
  it('renders a real trajectory row and opens its exact historical run in Payload', () => {
    const h = replay([checkpoint(9, 'unknown')], true)
    const snapshot = h.trajectory()
    const turns = deriveTrajectoryLayout({ ...snapshot, nodes: snapshot.eventNodes }, trajectoryT)
    const { container, rerender } = render(<TrajectoryTable turns={turns} t={trajectoryT}
      renderSlot={() => null} loadImage={async () => { throw new Error('Record fixture contains no image attachments') }} collapsedTurns={new Set()} onToggleTurn={() => {}}
      collapsedAssistants={new Set()} onToggleAssistant={() => {}} />)
    const row = container.querySelector('tr[data-kind="record"][data-trajectory-row-key]')!
    expect(row.textContent).toContain('production/checkpoint')
    expect(row.textContent).toContain('Actual unknown transition')
    expect(row.textContent).toContain('Workflow progress')
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('tab', { name: 'Payload' }))
    expect(screen.getByRole('tabpanel').textContent).toContain('same-workpiece')
    fireEvent.click(screen.getByText('run:', { exact: true }))
    fireEvent.click(screen.getByText('binding:', { exact: true }))
    expect(screen.getByRole('tabpanel').textContent).toContain('/original-slanted.3dm')
    expect(screen.getByRole('tabpanel').textContent).toContain('unknown')
    h.assembler.append(checkpoint(12, 'complete'))
    const updated = h.trajectory()
    rerender(<TrajectoryTable turns={deriveTrajectoryLayout({ ...updated, nodes: updated.eventNodes }, trajectoryT)} t={trajectoryT}
      renderSlot={() => null} loadImage={async () => { throw new Error('Record fixture contains no image attachments') }} collapsedTurns={new Set()} onToggleTurn={() => {}}
      collapsedAssistants={new Set()} onToggleAssistant={() => {}} />)
    expect(screen.getByRole('tabpanel').textContent).toContain('revision: 9')
    expect(screen.getByRole('tabpanel').textContent).toContain('unknown')
    expect(screen.getByRole('tabpanel').textContent).not.toContain('Actual complete transition')
  })
})
