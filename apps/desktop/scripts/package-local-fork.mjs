/** Assemble a local macOS Fork from built workspace packages and a compatible installed application. */
import { createHash } from 'node:crypto'
import {
  chmodSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MANAGED_ROOT = join(REPOSITORY, 'apps/desktop/.desktop-build/local-fork')
const OWNER_FILE = '.local-fork-owner.json'
const APP_NAME = 'DeepSeek Harness.app'
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

function json(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 }) }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function inside(root, path) { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)) }

/**
 * Refuse unowned destinations, links, source overlap and paths outside the disposable build root.
 * @param {string} managedRoot - Repository-owned candidate root.
 * @param {string} output - Requested build directory.
 * @param {string} sourceApp - Installed source application.
 * @returns {string} Absolute safe output directory.
 */
export function validateCandidateOutput(managedRoot, output, sourceApp) {
  const root = resolve(managedRoot), destination = resolve(output), source = resolve(sourceApp)
  if (!inside(root, destination) || inside(destination, source) || inside(source, destination)) {
    throw new Error('local Fork: candidate must be inside the managed build root and separate from the installed app')
  }
  for (let path = destination; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('local Fork: candidate ancestors cannot be symbolic links')
    if (path === dirname(path)) break
  }
  if (existsSync(destination)) {
    const marker = join(destination, OWNER_FILE)
    if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || json(marker).managedRoot !== root) {
      throw new Error('local Fork: existing candidate directory is not owned by this builder')
    }
  }
  return destination
}

/**
 * Keep application identity/version while removing official update control and recording local inputs.
 * @param {object} manifest - Installed application manifest.
 * @param {object} build - Local build metadata.
 * @returns {object} Candidate application manifest.
 */
export function forkApplicationManifest(manifest, build) {
  const value = { ...manifest, dshBuildCommit: build.sourceCommit, dshBuildDirty: build.sourceDirty,
    dshLocalFork: { schemaVersion: 1, buildRecord: 'local-fork-build.json', baseAsarSha256: build.baseAsarSha256 } }
  delete value.dshMandatoryUpdatePolicy
  return value
}

/**
 * Read original ASAR unpack flags without treating absent flags as a file outcome.
 * @param {object} header - ASAR header root.
 * @returns {Set<string>} Archive-relative paths to preserve outside the archive.
 */
export function unpackedPaths(header) {
  const paths = new Set()
  const visit = (entry, path, inherited) => {
    const unpacked = inherited || entry.unpacked === true
    if (entry.files) {
      for (const [name, child] of Object.entries(entry.files)) visit(child, path ? `${path}/${name}` : name, unpacked)
    } else if (unpacked) paths.add(path)
  }
  visit(header, '', false)
  return paths
}

function dependenciesEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL)/iu.test(key) && key !== 'NODE_OPTIONS'))
}

function command(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', env: dependenciesEnvironment(),
    maxBuffer: 16 * 1024 * 1024, ...options })
}

function packagingDependencies() {
  const desktopRequire = createRequire(join(REPOSITORY, 'apps/desktop/package.json'))
  const builderRequire = createRequire(desktopRequire.resolve('app-builder-lib/package.json'))
  return { asar: builderRequire('@electron/asar'), semver: builderRequire('semver') }
}

function workspacePackages() {
  const packages = new Map()
  const add = (directory) => {
    const path = join(directory, 'package.json')
    if (!existsSync(path)) return
    const manifest = json(path)
    if (typeof manifest.name === 'string') packages.set(manifest.name, { directory, manifest })
  }
  for (const group of ['packages', 'vendor', 'apps', 'native/system/packages']) {
    const root = join(REPOSITORY, group)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      if (group === 'packages') {
        for (const item of readdirSync(path, { withFileTypes: true })) if (item.isDirectory()) add(join(path, item.name))
      } else add(path)
    }
  }
  add(join(REPOSITORY, 'native/system'))
  return packages
}

function changedPackages(available, baseRef) {
  const paths = [
    ...command('git', ['diff', '--name-only', baseRef, '--'], { cwd: REPOSITORY }).split('\n'),
    ...command('git', ['ls-files', '--others', '--exclude-standard'], { cwd: REPOSITORY }).split('\n'),
  ].filter(Boolean)
  return [...available.values()].filter(pkg => paths.some(path => inside(pkg.directory, join(REPOSITORY, path))))
    .map(pkg => pkg.manifest.name).filter(name => name !== '@deepseek-ai/dsh-desktop')
}

function resolvePackageClosure(names, available, runtime) {
  const selected = new Set(names)
  for (const name of selected) {
    const pkg = available.get(name)
    if (!pkg || !name.startsWith('@deepseek-ai/dsh')) throw new Error(`local Fork: unsupported workspace replacement ${name}`)
    for (const dependency of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies })) {
      if (available.has(dependency) && !existsSync(join(runtime, 'node_modules', dependency, 'package.json'))) selected.add(dependency)
    }
  }
  return [...selected].sort()
}

function packageDependency(root, name, runtime) {
  for (let path = root; ; path = dirname(path)) {
    const candidate = join(path, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return json(candidate)
    if (path === runtime || path === dirname(path)) return undefined
  }
}

function verifyDependencies(runtime, selected, semver) {
  for (const name of selected) {
    const directory = join(runtime, 'node_modules', name), manifest = json(join(directory, 'package.json'))
    for (const [dependency, range] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (!PACKAGE_PATTERN.test(dependency)) throw new Error(`local Fork: invalid dependency name in ${name}`)
      const resolved = packageDependency(directory, dependency, runtime)
      if (resolved === undefined && manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue
      if (resolved === undefined || !semver.satisfies(resolved.version, range, { includePrerelease: true })) {
        throw new Error(`local Fork: ${name} needs unavailable or incompatible ${dependency}@${range}; rebuild the dependency tree explicitly`)
      }
    }
  }
}

function replacePackage(pkg, runtime, packs) {
  if (pkg.manifest.main && !existsSync(join(pkg.directory, pkg.manifest.main))) {
    throw new Error(`local Fork: build output missing for ${pkg.manifest.name}`)
  }
  const before = new Set(readdirSync(packs))
  command('pnpm', ['--dir', pkg.directory, 'pack', '--pack-destination', packs], { cwd: REPOSITORY })
  const added = readdirSync(packs).filter(name => name.endsWith('.tgz') && !before.has(name))
  if (added.length !== 1) throw new Error(`local Fork: expected one tarball for ${pkg.manifest.name}`)
  const file = added[0], tarball = join(packs, file)
  const packed = JSON.parse(command('tar', ['-xOzf', tarball, 'package/package.json']))
  if (packed.name !== pkg.manifest.name || packed.version !== pkg.manifest.version) throw new Error('local Fork: packed package identity changed')
  const entries = command('tar', ['-tzf', tarball]).trim().split('\n')
  if (entries.some(path => !path.startsWith('package/') || path.split('/').includes('..'))) throw new Error('local Fork: invalid packed path')
  const destination = join(runtime, 'node_modules', pkg.manifest.name)
  mkdirSync(destination, { recursive: true })
  // Preserve installed nested dependencies, including native modules; replace only this package's own payload.
  for (const name of readdirSync(destination)) if (name !== 'node_modules') rmSync(join(destination, name), { recursive: true, force: true })
  command('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination])
  const body = readFileSync(tarball)
  return { name: packed.name, version: packed.version, file, bytes: body.length,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}` }
}

/**
 * Rebuild an archive with exact original unpack flags and filesystem executable modes.
 * @param {object} asar - Installed @electron/asar API.
 * @param {string} tree - Materialized application root.
 * @param {string} archive - Candidate archive path.
 * @param {Set<string>} originalUnpacked - Original unpacked file paths.
 * @returns {Promise<void>} Resolves after archive and physical unpacked files are written.
 */
export async function writeForkArchive(asar, tree, archive, originalUnpacked) {
  const streams = []
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`local Fork: materialized application contains a link ${path}`)
      if (entry.isDirectory()) { streams.push({ type: 'directory', path, unpacked: false }); visit(file, path) }
      else if (entry.isFile()) {
        const unpacked = originalUnpacked.has(path) || /\.(?:node|dylib|so|dll|exe)$/u.test(path)
        streams.push({ type: 'file', path, stat: statSync(file), unpacked, streamGenerator: () => createReadStream(file) })
      } else throw new Error(`local Fork: unsupported materialized entry ${path}`)
    }
  }
  visit(tree)
  rmSync(archive, { force: true })
  rmSync(`${archive}.unpacked`, { recursive: true, force: true })
  await asar.createPackageFromStreams(archive, streams)
  asar.uncache(archive)
}

function copyDesktopPayload(tree) {
  const root = join(REPOSITORY, 'apps/desktop')
  const files = ['lib/main.js', 'lib/preload-app.cjs', 'lib/preload-mandatory.cjs', 'lib/preload-platform-account.cjs',
    'lib/preload-update-dialog.cjs', 'lib/preload-welcome.cjs', 'lib/welcome', 'renderer']
  for (const file of files) {
    const source = join(root, file)
    if (!existsSync(source)) throw new Error(`local Fork: desktop build output missing: ${file}`)
    rmSync(join(tree, file), { recursive: true, force: true })
    mkdirSync(dirname(join(tree, file)), { recursive: true })
    cpSync(source, join(tree, file), { recursive: true, dereference: false })
  }
}

function updateAsarIntegrity(asar, app) {
  const resources = join(app, 'Contents/Resources'), hashes = {}
  for (const name of readdirSync(resources).filter(name => name.endsWith('.asar'))) {
    hashes[`Resources/${name}`] = { algorithm: 'SHA256',
      hash: createHash('sha256').update(asar.getRawHeader(join(resources, name)).headerString).digest('hex') }
  }
  command('python3', ['-c', 'import json,plistlib,sys\np=sys.argv[1]\nwith open(p,"rb") as f:d=plistlib.load(f)\nd["ElectronAsarIntegrity"]=json.loads(sys.argv[2])\nwith open(p,"wb") as f:plistlib.dump(d,f,sort_keys=False)',
    join(app, 'Contents/Info.plist'), JSON.stringify(hashes)])
  return hashes
}

/**
 * Build only a managed candidate; never launch, quit, install or alter Harness user data.
 * @param {string[]} args - Command-line arguments.
 * @returns {Promise<object>} Candidate paths and recorded checks.
 */
export async function packageLocalFork(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { 'base-app': { type: 'string' }, out: { type: 'string' },
    package: { type: 'string', multiple: true }, 'base-ref': { type: 'string', default: 'dsh-v0.2.0-rc.2' } } })
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('local Fork: this reuse builder requires macOS arm64')
  const baseApp = realpathSync(values['base-app'] ?? join(homedir(), 'Applications', APP_NAME))
  const output = validateCandidateOutput(MANAGED_ROOT, values.out ?? join(MANAGED_ROOT, 'candidate'), baseApp)
  const candidate = join(output, APP_NAME)
  const processes = command('ps', ['-axo', 'command']).split('\n')
  if (processes.some(line => line.trimStart().startsWith(`${candidate}/Contents/MacOS/`))) throw new Error('local Fork: candidate is running; stop it before rebuilding')
  const { asar, semver } = packagingDependencies()
  const baseArchive = join(baseApp, 'Contents/Resources/app.asar'), baseManifest = JSON.parse(asar.extractFile(baseArchive, 'package.json'))
  const desktopManifest = json(join(REPOSITORY, 'apps/desktop/package.json'))
  const baseDescriptor = JSON.parse(asar.extractFile(baseArchive, 'dsh/desktop-runtime.json'))
  if (baseManifest.name !== desktopManifest.name || baseManifest.version !== desktopManifest.version
    || baseDescriptor.platform !== 'darwin' || baseDescriptor.arch !== 'arm64') throw new Error('local Fork: base application does not match source version/platform')
  command('codesign', ['--verify', '--deep', '--strict', baseApp])
  const baseAsarSha256 = sha256(baseArchive), baseInfoSha256 = sha256(join(baseApp, 'Contents/Info.plist'))
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY }).trim()
  const sourceDirty = command('git', ['status', '--porcelain'], { cwd: REPOSITORY }).trim() !== ''
  mkdirSync(dirname(output), { recursive: true })
  const work = mkdtempSync(join(dirname(output), '.local-fork-build-'))
  chmodSync(work, 0o700)
  const staged = join(work, APP_NAME), tree = join(work, 'asar-tree'), packs = join(work, 'packed')
  mkdirSync(packs)
  try {
    command('ditto', [baseApp, staged])
    asar.extractAll(baseArchive, tree)
    const originalUnpacked = unpackedPaths(asar.getRawHeader(baseArchive).header)
    for (const path of originalUnpacked) chmodSync(join(tree, path), statSync(join(`${baseArchive}.unpacked`, path)).mode & 0o777)
    const runtime = join(tree, 'dsh'), available = workspacePackages()
    const names = resolvePackageClosure(values.package ?? [...changedPackages(available, values['base-ref']),
      '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web-frontend'], available, runtime)
    if (!names.includes('@deepseek-ai/dsh-web-frontend')) throw new Error('local Fork: include the built Web frontend')
    const records = names.map(name => replacePackage(available.get(name), runtime, packs))
    copyDesktopPayload(tree)
    verifyDependencies(runtime, names, semver)
    const metadata = { schemaVersion: 1, kind: 'local-fork-reusing-installed-runtime', createdAt: new Date().toISOString(),
      sourceCommit, sourceDirty, baseRef: values['base-ref'], baseApp, baseVersion: baseManifest.version,
      baseBuildCommit: baseManifest.dshBuildCommit ?? null, baseAsarSha256, baseInfoSha256,
      replacedPackages: records, reused: ['Electron shell/frameworks', 'bundled Node/pnpm/Python/primary runtime',
        'third-party and native dependencies', 'unchanged first-party packages'],
      installedApplicationChanged: false, userDataChanged: false, officialReleaseBuild: false }
    writeJson(join(tree, 'package.json'), forkApplicationManifest(baseManifest, metadata))
    const manifest = json(join(runtime, 'package.json'))
    for (const entry of records) manifest.dependencies[entry.name] = entry.version
    writeJson(join(runtime, 'package.json'), manifest)
    const { writeDesktopRuntime, verifyDesktopRuntime } = await import('../src/runtime-tree.ts')
    const { verifyRuntimeArchive } = await import('./verify-runtime-archive.ts')
    const shared = [...new Set([...baseDescriptor.sharedPackages.map(pkg => pkg.name), ...names])].sort()
    const descriptor = writeDesktopRuntime(runtime, baseDescriptor.release, shared, { platform: 'darwin', arch: 'arm64' })
    await verifyDesktopRuntime(runtime, baseManifest.version, { platform: 'darwin', arch: 'arm64' })
    const archive = join(staged, 'Contents/Resources/app.asar')
    await writeForkArchive(asar, tree, archive, originalUnpacked)
    await verifyRuntimeArchive(archive, descriptor)
    const resources = join(staged, 'Contents/Resources')
    rmSync(join(resources, 'app-update.yml'), { force: true })
    const integrity = updateAsarIntegrity(asar, staged)
    metadata.asarSha256 = sha256(archive)
    metadata.electronAsarIntegrity = integrity
    metadata.runtimeFileCount = descriptor.files.length
    metadata.runtimeDescriptorSha256 = sha256(join(runtime, 'desktop-runtime.json'))
    metadata.checks = { runtimeBeforeArchive: true, runtimeArchive: true, officialUpdateFeedRemoved: !existsSync(join(resources, 'app-update.yml')) }
    writeJson(join(resources, 'local-fork-build.json'), metadata)
    command('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements',
      join(REPOSITORY, 'apps/desktop/scripts/macos-entitlements.plist'), staged])
    command('codesign', ['--verify', '--deep', '--strict', staged])
    await verifyRuntimeArchive(archive, descriptor)
    if (sha256(baseArchive) !== baseAsarSha256 || sha256(join(baseApp, 'Contents/Info.plist')) !== baseInfoSha256) throw new Error('local Fork: base application changed during assembly')
    mkdirSync(output, { recursive: true })
    writeJson(join(output, OWNER_FILE), { schemaVersion: 1, managedRoot: MANAGED_ROOT })
    const previous = join(work, 'previous.app')
    if (existsSync(candidate)) renameSync(candidate, previous)
    try { renameSync(staged, candidate) }
    catch (error) { if (existsSync(previous)) renameSync(previous, candidate); throw error }
    cpSync(packs, join(output, 'packed'), { recursive: true })
    writeJson(join(output, 'local-fork-package-set.json'), { schemaVersion: 1, packages: records,
      reusedPackages: shared.filter(name => !names.includes(name)).map(name => descriptor.sharedPackages.find(pkg => pkg.name === name)) })
    writeJson(join(output, 'build-result.json'), { ...metadata, candidate, checks: { ...metadata.checks,
      adHocSignature: true, runtimeArchiveAfterSigning: true, baseApplicationUnchanged: true }, launchVerified: false })
    return { candidate, buildRecord: join(output, 'build-result.json'), version: baseManifest.version,
      replacedPackages: names, officialReleaseBuild: false, installedApplicationChanged: false }
  } finally { rmSync(work, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await packageLocalFork(), undefined, 2))
}
