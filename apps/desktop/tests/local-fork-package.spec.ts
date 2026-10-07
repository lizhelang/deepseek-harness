import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, chmodSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { forkApplicationManifest, unpackedPaths, validateCandidateOutput, writeForkArchive, type ForkArchiveWriter } from '../scripts/package-local-fork.mjs'
import { localForkSmokeEnvironment } from '../scripts/smoke-local-fork.mjs'

describe('local Fork candidate ownership', () => {
  it('rejects installed app overlap, unowned output and symlink ancestors', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-local-fork-')))
    try {
      const managed = join(root, 'build'), app = join(root, 'installed.app')
      mkdirSync(managed); mkdirSync(app)
      expect(() => validateCandidateOutput(managed, app, app)).toThrow('managed build root')
      expect(() => validateCandidateOutput(managed, managed, app)).toThrow('not owned')
      symlinkSync(app, join(managed, 'linked'))
      expect(() => validateCandidateOutput(managed, join(managed, 'linked', 'child'), app)).toThrow('symbolic links')
      expect(validateCandidateOutput(managed, join(managed, 'candidate'), app)).toBe(join(managed, 'candidate'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('accepts a marked candidate and preserves identity while removing mandatory updates', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-local-fork-')))
    try {
      const output = join(root, 'candidate'); mkdirSync(output)
      writeFileSync(join(output, '.local-fork-owner.json'), JSON.stringify({ managedRoot: root }))
      expect(validateCandidateOutput(root, output, join(tmpdir(), 'other.app'))).toBe(output)
      const manifest = { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2', dshMandatoryUpdatePolicy: { origin: 'https://example.test' } }
      const updated = forkApplicationManifest(manifest, { sourceCommit: 'source', sourceDirty: true, baseAsarSha256: 'hash' })
      expect(updated).toMatchObject({ name: manifest.name, version: manifest.version, dshBuildCommit: 'source', dshBuildDirty: true })
      expect(updated).not.toHaveProperty('dshMandatoryUpdatePolicy')
      expect(manifest).toHaveProperty('dshMandatoryUpdatePolicy')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('local Fork ASAR placement', () => {
  it('retains unpack flags and executable permissions while adding packed JavaScript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-local-fork-asar-'))
    try {
      const require = createRequire(new URL('../package.json', import.meta.url))
      const builder = createRequire(require.resolve('app-builder-lib/package.json'))
      const asar = builder('@electron/asar') as ForkArchiveWriter & {
        statFile(archive: string, path: string): { unpacked?: boolean }
        extractFile(archive: string, path: string): Buffer
      }
      const tree = join(root, 'tree'); mkdirSync(tree)
      writeFileSync(join(tree, 'worker.js'), 'worker bytes')
      writeFileSync(join(tree, 'added.js'), 'new code')
      writeFileSync(join(tree, 'native.node'), 'native bytes'); chmodSync(join(tree, 'native.node'), 0o755)
      const flags = unpackedPaths({ files: { 'worker.js': { unpacked: true }, nested: { unpacked: true, files: { 'index.js': {} } } } })
      expect([...flags]).toEqual(['worker.js', 'nested/index.js'])
      const archive = join(root, 'app.asar')
      await writeForkArchive(asar, tree, archive, flags)
      expect(asar.statFile(archive, 'worker.js').unpacked).toBe(true)
      expect(asar.statFile(archive, 'added.js').unpacked).not.toBe(true)
      expect(asar.extractFile(archive, 'added.js').toString()).toBe('new code')
      expect(readFileSync(join(`${archive}.unpacked`, 'native.node'), 'utf8')).toBe('native bytes')
      expect(statSync(join(`${archive}.unpacked`, 'native.node')).mode & 0o100).toBe(0o100)
      expect(asar.statFile(archive, 'native.node').unpacked).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

it('isolates smoke storage and discards inherited provider credentials and live overrides', () => {
  const environment = localForkSmokeEnvironment({ PATH: '/bin', HOME: '/account', DEEPSEEK_API_KEY: 'secret',
    DSH_HOME: '/live', DSH_DESKTOP_DSH_DIR: '/live/runtime', NODE_OPTIONS: '--require bad', ELECTRON_RUN_AS_NODE: '1' }, '/private/smoke')
  expect(environment).toMatchObject({ PATH: '/bin', HOME: '/account', DSH_HOME: '/private/smoke/home',
    DSH_DESKTOP_USER_DATA_DIR: '/private/smoke/browser', DSH_TELEMETRY_MODE: 'DISABLED' })
  expect(environment).not.toHaveProperty('DEEPSEEK_API_KEY')
  expect(environment).not.toHaveProperty('DSH_DESKTOP_DSH_DIR')
  expect(environment).not.toHaveProperty('NODE_OPTIONS')
  expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
})
