/** Isolated, credential-free Desktop launch smoke; never runs model tasks or loads the user's profile. */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PRIVATE_ROOT = join(REPOSITORY, 'apps/desktop/.desktop-build/local-fork/smokes')
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

/**
 * Keep provider secrets out of a fresh smoke and select private storage explicitly.
 * @param {object} environment - Parent environment.
 * @param {string} root - Unique owned smoke directory.
 * @returns {Record<string, string>} Child environment without provider credentials or live Harness path overrides.
 */
export function localForkSmokeEnvironment(environment, root) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([name, value]) => typeof value === 'string'
    && !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name) && !/^(?:DSH_|ELECTRON_|NODE_OPTIONS|NODE_PATH)/u.test(name))),
  DSH_HOME: join(root, 'home'), DSH_DESKTOP_USER_DATA_DIR: join(root, 'browser'), DSH_TELEMETRY_MODE: 'DISABLED',
  DSH_DESKTOP_OPEN_DEVTOOLS: '0' }
}

function ownedProcesses(root) {
  return execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    return match && match[2].includes(root) ? [Number(match[1])] : []
  }).filter(pid => pid !== process.pid)
}

/**
 * Launch a candidate on private Harness/Electron storage, enter without credentials, and await normal teardown.
 * @param {string[]} args - Explicit candidate path and optional result path.
 * @returns {Promise<object>} Startup observations and teardown evidence; no business acceptance claim.
 */
export async function smokeLocalFork(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { app: { type: 'string' }, output: { type: 'string' } } })
  if (!values.app) throw new Error('local Fork smoke: provide --app pointing to the built candidate')
  const application = resolve(values.app)
  if (!application.startsWith(join(REPOSITORY, 'apps/desktop/.desktop-build/local-fork') + '/')) {
    throw new Error('local Fork smoke: only this repository candidate can be launched')
  }
  mkdirSync(PRIVATE_ROOT, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(PRIVATE_ROOT, 'run-')), home = join(root, 'home'), browser = join(root, 'browser')
  const profile = join(home, 'profiles/desktop')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  // The official Desktop initializer supplies its own bundle manifest; only pin this private listener to an ephemeral port.
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n', { mode: 0o600 })
  const require = createRequire(join(REPOSITORY, 'apps/web/package.json'))
  const { _electron } = require('playwright')
  const result = { schemaVersion: 1, application, privateRoot: root, userDataChanged: false,
    modelActionsSubmitted: false, rhinoActionsSubmitted: false, startupPassed: false, gracefulExit: false }
  let desktop, child, exited = false, exit
  try {
    desktop = await _electron.launch({ executablePath: join(application, 'Contents/MacOS/DeepSeek Harness'),
      args: [`--user-data-dir=${browser}`], cwd: root, env: localForkSmokeEnvironment(process.env, root), timeout: 60_000 })
    child = desktop.process()
    exit = new Promise(resolveExit => child.once('exit', (code, signal) => { exited = true; result.exitCode = code; result.exitSignal = signal; resolveExit() }))
    const paths = await desktop.evaluate(({ app }) => ({ userData: app.getPath('userData'), home: process.env.DSH_HOME, version: app.getVersion() }))
    if (paths.userData !== browser || paths.home !== home) throw new Error('local Fork smoke: storage isolation mismatch')
    await desktop.evaluate(({ app }, logs) => { app.setAppLogsPath(logs) }, join(root, 'logs'))
    result.paths = paths
    let welcome
    for (let attempt = 0; attempt < 240; attempt += 1) {
      welcome = desktop.windows().find(page => page.url().includes('/renderer/welcome.html'))
      if (welcome) break
      await wait(250)
    }
    if (!welcome) throw new Error('local Fork smoke: credential-free welcome did not open')
    await welcome.waitForLoadState('domcontentloaded')
    // Workspace readiness below confirms this transition after Welcome destroys its own renderer.
    await welcome.evaluate(() => { void window.dshWelcome.skip() })
    let workspace
    for (let attempt = 0; attempt < 120; attempt += 1) {
      workspace = desktop.windows().find(page => page.url().startsWith('dsh-app://app/'))
      if (workspace) break
      await wait(250)
    }
    if (!workspace) throw new Error('local Fork smoke: workspace window did not open')
    await workspace.waitForLoadState('domcontentloaded')
    await workspace.locator('#root > *').first().waitFor({ state: 'visible', timeout: 30_000 })
    result.workspaceLoaded = true
    result.startupPassed = true
  } catch (error) {
    // Host errors may carry authenticated URLs; record the class, never raw launch logs or headers.
    result.errorKind = error.constructor.name
  } finally {
    if (desktop && !exited) {
      try { await desktop.evaluate(({ app }) => { app.quit() }) }
      catch (error) { result.quitConnectionClosed = error.constructor.name }
      if (exit) await Promise.race([exit, wait(25_000)])
      if (!exited && child) {
        result.forcedOwnedTeardown = true
        child.kill('SIGTERM')
        await Promise.race([exit, wait(5_000)])
        if (!exited) { child.kill('SIGKILL'); await Promise.race([exit, wait(5_000)]) }
      }
    }
    for (let attempt = 0; attempt < 40 && ownedProcesses(root).length; attempt += 1) await wait(250)
    result.ownedProcessesRemaining = ownedProcesses(root).length
    result.gracefulExit = exited && !result.forcedOwnedTeardown && result.ownedProcessesRemaining === 0
    result.passed = result.startupPassed && result.gracefulExit
    const output = values.output ? resolve(values.output) : join(root, 'result.json')
    if (!output.startsWith(PRIVATE_ROOT + '/') || existsSync(output)) throw new Error('local Fork smoke: result must be a fresh file inside the private smoke root')
    writeFileSync(output, `${JSON.stringify(result, undefined, 2)}\n`, { mode: 0o600 })
    result.resultPath = output
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await smokeLocalFork()
  console.log(JSON.stringify(result, undefined, 2))
  if (!result.passed) process.exitCode = 1
}
