/** Create a credential-free environment for an isolated candidate launch. */
export function localForkSmokeEnvironment(environment: object, root: string): Record<string, string>
/** Run candidate startup and await teardown using only owned private storage. */
export function smokeLocalFork(args?: string[]): Promise<object>
