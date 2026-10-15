/** Keyless real-Web integration: shared state, local human waits and editor gestures. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { ProductionRun } from '@deepseek-ai/dsh-production-studio'
import type {} from '@deepseek-ai/dsh-production-studio'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { writeFixtureCase } from '../../../packages/workflow/production-studio/tests/fixture-case.ts'
import { launchWebScaffold, readPersistedEvents, type WebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, writeComposerDraft } from './support.ts'

describe('independently scheduled production tasks', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleWatch: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch({ channel: process.env.DSH_TEST_BROWSER_CHANNEL ?? 'chrome' })
    page = await newEnglishPage(browser)
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'read-probe.txt'), 'independent read branch')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('streams real runs to the conversation dock and priority list while independent branches finish', async () => {
    onTestFailed(async () => {
      const evidenceDir = process.env.DSH_PRODUCTION_EVIDENCE_DIR
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await page.screenshot({ path: join(evidenceDir, 'production-failure.png') })
        await writeFile(join(evidenceDir, 'production-failure-aria.txt'), await page.locator('body').ariaSnapshot())
      }
    })
    const agent = scaffold.ctx.agents.list()[0]
    expect(agent).toBeDefined()
    if (!agent) throw new Error('No live conversation was created')
    const service = scaffold.ctx.productionStudio
    expect(service).toBeDefined()
    const initial = await service.get(agent.id)
    const graph = structuredClone(initial.graph)
    const baseline = graph.nodes.find(node => node.id === 'baseline')
    if (!baseline) throw new Error('Missing baseline node')
    baseline.kind = 'human'
    baseline.config = { question: 'Provide the missing workpiece information' }
    graph.nodes.push({ id: 'independent-read', label: 'Independent read', kind: 'program', x: 900, y: 40,
      inputs: [], outputs: [], maxAttempts: 1, config: { toolName: 'read', arguments: { file_path: 'read-probe.txt' } } })
    const saved = await service.saveGraph(agent.id, { expectedVersion: initial.graph.version, graph })
    const first = await service.start(agent.id, { graphVersion: saved.graph.version, objective: 'Await workpiece input', goalContractAcknowledged: true, input: { deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Await workpiece input' } } })
    const run = first.runs.at(-1)
    if (!run) throw new Error('Run was not persisted')
    await expect.poll(async () => {
      const latest = (await service.get(agent.id)).runs.find(item => item.id === run.id)
      const task = latest?.tasks.find(task => task.nodeId === 'independent-read')
      if (task?.phase === 'unknown' || task?.phase === 'blocked') throw new Error(JSON.stringify(task))
      return task?.phase
    }).toBe('complete')
    expect((await service.get(agent.id)).runs.find(item => item.id === run.id)?.tasks.find(task => task.nodeId === 'baseline')?.phase).toBe('human')
    const dock = page.locator('[data-production-dock]')
    await dock.waitFor()
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
    const row = page.locator(`[data-production-monitor] [data-production-run="${run.id}"]`).first()
    await row.locator('summary').first().click()
    const answer = row.locator('[data-production-branch="baseline"] textarea')
    await answer.fill('Unsent workpiece details stay here')
    await service.start(agent.id, { graphVersion: saved.graph.version, objective: 'Second independent workpiece', goalContractAcknowledged: true, input: { deliveryGoal: { kind: 'verified-drawings', objectiveText: 'Second independent workpiece' } } })
    await expect.poll(() => page.locator('[data-production-monitor] [data-production-run]').count()).toBe(2)
    expect(await answer.inputValue()).toBe('Unsent workpiece details stay here')
    expect(await page.locator('[data-production-group]').first().getAttribute('data-production-group')).toBe('human')
    const evidenceDir = process.env.DSH_PRODUCTION_EVIDENCE_DIR
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await page.screenshot({ path: join(evidenceDir, 'production-monitor.png') })
    }
    await page.getByRole('tab', { name: 'Workflow', exact: true }).click()
    await page.locator('[data-production-canvas]').waitFor()
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'production-workflow.png') })
    expect(consoleWatch.pageErrors).toEqual([])
  })
})

const CONVERSATION_PROVIDER = 'production-conversation-web-test'
const CONVERSATION_TOOL = 'production_conversation_fixture'
const FUTURE_PROMPT = 'Use the future instruction edited in this same conversation workflow.'

class ConversationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) {
    return [{ provider, id: 'conversation-fixture', name: 'Keyless conversation fixture' }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = [
      toolCallResponse('conversation-baseline', CONVERSATION_TOOL, {}),
      textResponse('Waiting for the decision in this same workflow.'),
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

it('drives Chat, Trajectory, Tasks and Workflow from one parent conversation and applies future edits without Start', async () => {
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

    await view.getByRole('tab', { name: 'Workflow', exact: true }).click()
    const editor = view.locator('[data-production-editor]')
    await editor.getByRole('button', { name: 'Fit to window', exact: true }).click()
    await expect.poll(() => editor.locator('[data-production-node="baseline"]').getAttribute('data-phase')).toBe('running')
    expect(await editor.getByRole('button', { name: 'Start task', exact: true }).count()).toBe(0)
    await editor.locator('[data-production-node="manufacture"] > button').click()
    await editor.getByRole('textbox', { name: 'Role and execution prompt', exact: true }).fill(FUTURE_PROMPT)
    await editor.getByRole('button', { name: 'Save workflow', exact: true }).click()
    await expect.poll(async () => (await currentRun()).graph.nodes.find(node => node.id === 'manufacture')?.config.prompt).toBe(FUTURE_PROMPT)
    const edited = await service.get(parent.id)
    const graph = structuredClone(edited.graph)
    graph.nodes.push({ id: 'decision', label: 'Approve before manufacture', kind: 'human', x: 450, y: 40,
      inputs: [{ id: 'input', type: 'geometry' }], outputs: [{ id: 'success', type: 'geometry', outlet: 'success' }],
      maxAttempts: 1, config: { question: 'Continue the same workflow?' } })
    const route = graph.edges.find(edge => edge.fromNode === 'geometry' && edge.fromPort === 'success')
    if (!route) throw new Error('The current graph has no geometry success route')
    route.toNode = 'decision'
    graph.edges.push({ id: 'decision-manufacture', fromNode: 'decision', fromPort: 'success', toNode: 'manufacture', toPort: 'input' })
    await world.ctx.typertGateway.invoke({ peer: new Peer(world.ctx, { principal: { kind: 'owner' } }), namespace: 'productionStudio', method: 'saveGraph',
      args: { sessionId: parent.id, request: { expectedVersion: edited.graph.version, graph } } })
    const routed = await currentRun()
    expect(routed.id).toBe(admitted.id)
    expect(routed.graph.version).toBeGreaterThan(admitted.graph.version)
    expect(routed.tasks.find(task => task.nodeId === 'baseline')?.operationId).toBe('conversation-baseline')
    await capture('edited-workflow')
    releaseFirst.resolve(undefined)
    await expect.poll(async () => (await currentRun()).tasks.find(task => task.nodeId === 'decision')?.phase).toBe('human')
    await parent.whenIdle()
    expect(calls).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.tools ?? []).toHaveLength(0)
    expect((await world.ctx.tools.execute({ callId: ToolCallId('blocked-before-approval'), name: CONVERSATION_TOOL,
      arguments: {}, agent: parent, signal: new AbortController().signal })).isError).toBe(true)
    expect(calls).toBe(1)
    const waiting = await currentRun()
    const persisted = await readPersistedEvents(world, parent.id)
    const checkpoint = persisted.findLast(event => event.type === 'production/checkpoint' && event.data.run.revision === waiting.revision)
    if (!checkpoint || checkpoint.type !== 'production/checkpoint') throw new Error('The waiting state has no durable checkpoint')
    expect(checkpoint.ignorable).toBe(true)
    expect(checkpoint.data.run.id).toBe(admitted.id)
    await view.getByRole('tab', { name: 'Chat', exact: true }).click()
    const chatCheckpoint = view.locator(`[data-production-checkpoint="${checkpoint.seq}"][data-production-run="${admitted.id}"]`)
    await expandOwningTurnProcess(view, chatCheckpoint)
    await chatCheckpoint.waitFor()
    await chatCheckpoint.getByText('Node states at this checkpoint', { exact: true }).click()
    await expect.poll(() => chatCheckpoint.textContent()).toContain('Approve before manufacture')
    await capture('waiting-chat')
    await view.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    const trajectory = view.locator('[data-trajectory-scroll] tr[data-trajectory-row-key]').filter({ hasText: 'production/checkpoint' }).last()
    await trajectory.waitFor()
    await trajectory.click()
    await view.getByRole('tab', { name: 'Payload', exact: true }).click()
    await expect.poll(() => view.getByRole('tabpanel').textContent()).toContain(admitted.id)
    await capture('waiting-trajectory')

    await view.getByRole('tab', { name: 'Tasks', exact: true }).click()
    if (await monitor.getAttribute('open') === null) await monitor.locator('summary').first().click()
    const decision = monitor.locator('[data-production-branch="decision"]')
    await decision.getByRole('textbox', { name: 'Additional information or decision', exact: true }).fill('Proceed in this same run')
    await decision.getByRole('button', { name: 'Accept and continue', exact: true }).click()
    await expect.poll(async () => (await currentRun()).phase).toBe('complete')
    await parent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests[2]?.messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text.includes(FUTURE_PROMPT)))).toBe(true)
    const completed = await currentRun()
    expect(completed.id).toBe(admitted.id)
    expect(completed.tasks.every(task => task.childSessionId === undefined)).toBe(true)
    expect(completed.tasks.find(task => task.nodeId === 'delivery')?.certificates.toSorted()).toEqual(['files', 'geometry', 'goal', 'manufacturing'])
    expect(world.ctx.agents.list().map(agent => agent.id)).toEqual(originalSessions)
    const finalEvents = await readPersistedEvents(world, parent.id)
    expect(finalEvents.filter(event => event.type === 'tool/call' && event.data.name === CONVERSATION_TOOL)).toHaveLength(2)
    expect(finalEvents.filter(event => event.type === 'production/checkpoint').every(event => event.type === 'production/checkpoint' && event.data.run.id === admitted.id)).toBe(true)
    expect(checkpoint.data.run.tasks.find(task => task.nodeId === 'decision')?.phase).toBe('human')
    await view.locator('[data-production-monitor] [data-production-group="complete"] > summary').click()
    if (await monitor.getAttribute('open') === null) await monitor.locator('summary').first().click()
    await expect.poll(() => monitor.locator('[data-production-delivery]').count()).toBe(1)
    await capture('complete-monitor')
    await view.getByRole('tab', { name: 'Workflow', exact: true }).click()
    await expect.poll(() => editor.locator('[data-production-node="delivery"]').getAttribute('data-phase')).toBe('complete')
    await capture('complete-workflow')
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
