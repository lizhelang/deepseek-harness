/** Types for the standalone local candidate assembler. */
export interface ForkBuildInput {
  readonly sourceCommit: string
  readonly sourceDirty: boolean
  readonly baseAsarSha256: string
}
export interface AsarHeaderEntry {
  readonly unpacked?: boolean
  readonly files?: Readonly<Record<string, AsarHeaderEntry>>
}
export interface ForkArchiveWriter {
  createPackageFromStreams(destination: string, streams: object[]): Promise<object>
  uncache(archive: string): boolean
}
/** Refuse an unowned or overlapping build destination. */
export function validateCandidateOutput(managedRoot: string, output: string, sourceApp: string): string
/** Preserve installed identity and remove official mandatory update metadata. */
export function forkApplicationManifest(manifest: object, build: ForkBuildInput): object
/** List archive paths whose physical unpack placement must be retained. */
export function unpackedPaths(header: AsarHeaderEntry): Set<string>
/** Write a materialized archive while retaining unpack placement and executable modes. */
export function writeForkArchive(asar: ForkArchiveWriter, tree: string, archive: string, originalUnpacked: Set<string>): Promise<void>
/** Assemble a managed candidate without launching or installing it. */
export function packageLocalFork(args?: string[]): Promise<object>
