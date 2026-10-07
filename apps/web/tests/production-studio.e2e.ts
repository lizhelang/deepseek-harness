/** Keyless real-Web integration: shared state, local human waits and editor gestures. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-production-studio'
import { launchWebScaffold, type WebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

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
