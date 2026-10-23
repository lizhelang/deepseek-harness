/** Keyless real-Web integration: one conversation drives Chat, Trajectory, Tasks and Run policy. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio'
import type {} from '@deepseek-ai/dsh-production-studio'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { writeFixtureCase } from '../../../packages/workflow/production-studio/tests/fixture-case.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, writeComposerDraft } from './support.ts'

const CONVERSATION_PROVIDER = 'production-conversation-web-test'
const CONVERSATION_TOOL = 'production_conversation_fixture'

class ConversationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) {
    return [{ provider, id: 'conversation-fixture', name: 'Keyless conversation fixture' }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = [
      toolCallResponse('conversation-baseline', CONVERSATION_TOOL, {}),
      toolCallResponse('conversation-manufacture', CONVERSATION_TOOL, {}),
      textResponse('Completed the same conversation workflow.'),
    ]
    const chunks = script[this.requests.length - 1]
    if (!chunks) throw new Error('Conversation fixture received an unexpected model request')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

it('drives Chat, Trajectory, Tasks and Run policy from one parent conversation without Start', async () => {
  const world = await launchWebScaffold()
  const adapter = new ConversationAdapter()
  const firstDispatch = Promise.withResolvers<undefined>()
  const releaseFirst = Promise.withResolvers<undefined>()
  let webBrowser: Browser | undefined
  let captureFailure: (() => Promise<void>) | undefined
  try {
    world.ctx.effect(() => world.ctx.llm.registerAdapter([CONVERSATION_PROVIDER], adapter), 'production conversation fixture adapter')
    await world.ctx.agentDefaultModel.saveSelection({ provider: CONVERSATION_PROVIDER, model: 'conversation-fixture' })
    webBrowser = await chromium.launch({ channel: process.env.DSH_TEST_BROWSER_CHANNEL ?? 'chrome' })
    const view = await newEnglishPage(webBrowser)
    const tripwire = watchConsole(view)
    const evidenceDir = process.env.DSH_PRODUCTION_EVIDENCE_DIR
    const capture = async (name: string): Promise<void> => {
      if (!evidenceDir) return
      await mkdir(evidenceDir, { recursive: true })
      await view.screenshot({ path: join(evidenceDir, `conversation-${name}.png`), fullPage: true })
      await writeFile(join(evidenceDir, `conversation-${name}-aria.txt`), await view.locator('body').ariaSnapshot())
    }
    captureFailure = () => capture('failure')
    await view.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(view, world.workspaceCwd)
    const parent = world.ctx.agents.list()[0]
    if (!parent) throw new Error('The real Web composer did not create its parent conversation')
    const originalSessions = world.ctx.agents.list().map(agent => agent.id)
    const fixture = await writeFixtureCase(join(world.workspaceCwd, 'workspace', 'conversation-case'))
    const receiptPath = join(world.workspaceCwd, 'workspace', 'conversation-case', 'receipt.json')
    await writeFile(receiptPath, JSON.stringify(fixture.receipt))
    let calls = 0
    world.ctx.effect(() => world.ctx.tools.register(defineTool({
      name: CONVERSATION_TOOL,
      description: 'Read an isolated fixture receipt without native or external operations',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, execution) => {
        expect(execution.agent).toBe(parent)
        calls++
        if (calls === 1) {
          firstDispatch.resolve(undefined)
          await releaseFirst.promise
          execution.signal.throwIfAborted()
        }
        return readFile(receiptPath, 'utf8')
      },
    })), 'production conversation fixture tool')
    world.ctx.effect(() => world.ctx.productionStudio.registerConversationWorkflow({
      id: 'aea-web-fixture', toolNames: [CONVERSATION_TOOL], appliesTo: agent => agent === parent,
      start: () => ({ key: fixture.input.caseId, objective: 'Deliver this fixture through the same conversation',
        input: { ...fixture.input, deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Deliver this fixture through the same conversation' } } }),
      observe: () => ({ outlet: 'success' }),
    }), 'production conversation fixture binding')
    const service = world.ctx.productionStudio
    const currentRun = async (): Promise<ProductionRun> => {
      const state = await service.get(parent.id)
      expect(state.runs).toHaveLength(1)
      const run = state.runs[0]
      if (!run) throw new Error('The parent tool call did not establish its workflow')
      return run
    }
    const composer = view.locator('[data-composer-input]').first()
    await writeComposerDraft(view, composer, 'Deliver this fixture through the same conversation')
    await composer.press('Enter')
    await expect.poll(() => calls, { timeout: 30_000 }).toBe(1)
    await firstDispatch.promise
    const admitted = await currentRun()
    expect(admitted.mode).toBe('conversation')
    expect(admitted.binding).toEqual({ provider: 'aea-web-fixture', key: fixture.input.caseId })
    expect(admitted.tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('running')
    const dock = view.locator('[data-production-dock]')
    await dock.getByRole('button', { name: 'Expand task monitor', exact: true }).click()
    await dock.locator(`[data-production-run="${admitted.id}"]`).waitFor()
    await expect.poll(() => dock.textContent()).toContain('1 running')
    await dock.getByRole('button', { name: 'Collapse task monitor', exact: true }).click()
    await view.getByRole('tab', { name: 'Tasks', exact: true }).click()
    const monitor = view.locator(`[data-production-monitor] [data-production-run="${admitted.id}"]`)
    await monitor.waitFor()
    await monitor.locator('summary').first().click()
    await expect.poll(() => monitor.locator('[data-production-branch="baseline"]').getAttribute('data-phase')).toBe('running')
    await capture('running-monitor')

    await view.getByRole('tab', { name: 'Run policy', exact: true }).click()
    await view.locator('[data-production-policy]').waitFor()
    expect(await view.locator('[data-production-canvas]').count()).toBe(0)
    expect(await view.getByRole('button', { name: 'Start task', exact: true }).count()).toBe(0)
    await capture('run-policy')
    releaseFirst.resolve(undefined)
    await expect.poll(async () => (await currentRun()).phase).toBe('complete')
    await parent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests).toHaveLength(3)
    const completed = await currentRun()
    const persisted = await readPersistedEvents(world, parent.id)
    const checkpoint = persisted.findLast(event => event.type === 'production/checkpoint' && event.data.run.revision === completed.revision)
    if (!checkpoint || checkpoint.type !== 'production/checkpoint') throw new Error('The completed state has no durable checkpoint')
    expect(checkpoint.ignorable).toBe(true)
    expect(checkpoint.data.run.id).toBe(admitted.id)
    await view.getByRole('tab', { name: 'Chat', exact: true }).click()
    const chatCheckpoint = view.locator(`[data-production-checkpoint="${checkpoint.seq}"][data-production-run="${admitted.id}"]`)
    await expandOwningTurnProcess(view, chatCheckpoint)
    await chatCheckpoint.waitFor()
    await chatCheckpoint.getByText('Node states at this checkpoint', { exact: true }).click()
    await expect.poll(() => chatCheckpoint.textContent()).toContain('交付')
    await capture('complete-chat')
    await view.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    const trajectory = view.locator('[data-trajectory-scroll] tr[data-trajectory-row-key]').filter({ hasText: 'production/checkpoint' }).last()
    await trajectory.waitFor()
    await trajectory.click()
    await view.getByRole('tab', { name: 'Payload', exact: true }).click()
    await expect.poll(() => view.getByRole('tabpanel').textContent()).toContain(admitted.id)
    await capture('complete-trajectory')

    await view.getByRole('tab', { name: 'Tasks', exact: true }).click()
    expect(completed.id).toBe(admitted.id)
    expect(completed.tasks.every(task => task.childSessionId === undefined)).toBe(true)
    expect(completed.tasks.find(task => task.nodeId === 'delivery')?.certificates.toSorted()).toEqual(['files', 'geometry', 'goal', 'manufacturing'])
    expect(world.ctx.agents.list().map(agent => agent.id)).toEqual(originalSessions)
    const finalEvents = await readPersistedEvents(world, parent.id)
    expect(finalEvents.filter(event => event.type === 'tool/call' && event.data.name === CONVERSATION_TOOL)).toHaveLength(2)
    expect(finalEvents.filter(event => event.type === 'production/checkpoint').every(event => event.type === 'production/checkpoint' && event.data.run.id === admitted.id)).toBe(true)
    await view.locator('[data-production-monitor] [data-production-group="complete"] > summary').click()
    if (await monitor.getAttribute('open') === null) await monitor.locator('summary').first().click()
    await expect.poll(() => monitor.locator('[data-production-delivery]').count()).toBe(1)
    await capture('complete-monitor')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await captureFailure?.()
    throw error
  } finally {
    releaseFirst.resolve(undefined)
    try { await webBrowser?.close() }
    finally { await world.close() }
  }
})
