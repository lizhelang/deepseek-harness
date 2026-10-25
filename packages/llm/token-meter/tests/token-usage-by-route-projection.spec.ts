import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenRouteUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

function attempt(session: Session, usage: TokenUsage, turn: number, step: number): void {
  session.append('assistant/attempt', {
    turn,
    step,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
  })
}

function settle(session: Session, usage: TokenUsage | undefined, turn: number, step: number, route = { provider: '', model: '' }): void {
  session.append('assistant/message', {
    stream: usage === undefined ? [] : [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    turn,
    step,
    message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', ...route } }),
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
}

const projected = (ctx: Context, session: Session): TokenRouteUsageProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.tokenUsageByRoute
  if (value === undefined) throw new Error('tokenUsageByRoute projection is not registered')
  return value
}

const buckets = (input: number, output: number, cacheRead = 0) => ({
  uncachedInputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
})

describe('tokenUsageByRoute session projection', () => {
  it('attributes samples to the settled message route, else the newest request context', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ routes: [] })

    attempt(session, { inputTokens: 1, outputTokens: 1 }, 1, 1)
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-flash' })
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-flash' })
    settle(session, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 }, 1, 2)
    settle(session, { inputTokens: 20, outputTokens: 4 }, 1, 3, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    settle(session, undefined, 1, 4)

    expect(projected(ctx, session).routes).toEqual([
      { provider: '', model: '', ...buckets(1, 1) },
      { provider: 'deepseek', model: 'deepseek-flash', ...buckets(10, 2, 5) },
      { provider: 'deepseek', model: 'deepseek-v4-pro', ...buckets(20, 4) },
    ])
  })

  it('replaces a same-attempt sample across routes and accumulates retried attempts', async () => {
    const { ctx, session } = await harness()
    const changes: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'tokenUsageByRoute') changes.push(value)
    })
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-flash' })
    settle(session, { inputTokens: 3, outputTokens: 1 }, 1, 1)
    attempt(session, { inputTokens: 4, outputTokens: 1 }, 1, 2)
    attempt(session, { inputTokens: 4, outputTokens: 1 }, 1, 2)
    expect(changes).toHaveLength(3)

    // The final message names another route: the chunk's buckets move with it.
    settle(session, { inputTokens: 5, outputTokens: 2 }, 1, 2, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    session.append('llm/retry-started', { retryId: RetryId('other-step'), turn: 9, step: 9, retry: 1 })
    session.append('llm/retry-started', { retryId: RetryId('by-route'), turn: 1, step: 2, retry: 1 })
    settle(session, { inputTokens: 5, outputTokens: 2 }, 1, 2, { provider: 'deepseek', model: 'deepseek-v4-pro' })

    expect(projected(ctx, session).routes).toEqual([
      { provider: 'deepseek', model: 'deepseek-flash', ...buckets(3, 1) },
      { provider: 'deepseek', model: 'deepseek-v4-pro', ...buckets(10, 4) },
    ])

    // A replacement that empties its route drops the entry.
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat' })
    attempt(session, { inputTokens: 6, outputTokens: 0 }, 2, 1)
    settle(session, { inputTokens: 6, outputTokens: 1 }, 2, 1, { provider: 'deepseek', model: 'deepseek-flash' })
    expect(projected(ctx, session).routes).toEqual([
      { provider: 'deepseek', model: 'deepseek-flash', ...buckets(9, 2) },
      { provider: 'deepseek', model: 'deepseek-v4-pro', ...buckets(10, 4) },
    ])
  })
})
