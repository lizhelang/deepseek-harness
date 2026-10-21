/** Protocol invariants at JSON/SSE boundaries, including partial and failed responses. */
import { describe, expect, it } from 'vitest'
import { translate } from '../src/translate.ts'
import { parseSse } from '../src/sse.ts'
import { providerError } from '../src/transport.ts'
import { assemble, chunks, end, events, MODEL, sse, start, textEvents } from './helpers.ts'

describe('Messages stream', () => {
  it('streams text already present in the starting block', async () => {
    const result = await chunks(translate(events([start, { ...textEvents[1], content_block: { type: 'text', text: 'initial' } }, textEvents[3]!, ...end()]), MODEL, true))
    expect(result).toContainEqual({ type: 'text-delta', index: 0, text: 'initial' })
    expect(providerError({ error: { code: 'insufficient_balance' } }, 400)).toMatchObject({ code: 'QUOTA' })
  })

  it('emits first-seen blocks, raw tool JSON and cumulative disjoint usage before finish', async () => {
    const values = [
      { ...start, message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } } },
      { type: 'content_block_start', index: 4, content_block: { type: 'thinking', thinking: 'first', signature: '' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'thinking_delta', thinking: ' thought' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'nature' } },
      { type: 'content_block_stop', index: 4 },
      { type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: ' "a"}' } },
      { type: 'content_block_stop', index: 9 },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } },
      ...end('tool_use'),
    ]
    const result = await assemble(translate(events(values), MODEL, true))
    expect(result.message.content).toEqual([{ type: 'reasoning', text: 'first thought' }, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path": "a"}' }])
    expect(result.output.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 7, totalTokens: 54 } })
    expect(result.output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' }, replayState: { blocks: [{ type: 'reasoning', signature: 'signature' }, { type: 'tool-call' }] } })
    expect(result.output.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)).toEqual([0, 1])
  })

  it.each(['end_turn', 'stop_sequence'])('maps %s and ignores forward-compatible envelope events', async (reason) => {
    const result = await chunks(translate(events([start, { type: 'future_event' }, ...textEvents.slice(1, 4), ...end(reason)]), MODEL, true))
    expect(result.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it.each([{}, { key: 'initial' }])('preserves initial tool input %j without JSON deltas', async (input) => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]), MODEL, true))
    expect(result.message.content[0]).toMatchObject({ arguments: JSON.stringify(input) })
  })

  it('preserves signature-only thinking and prunes truncated tools with their replay entries', async () => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
      { type: 'content_block_stop', index: 1 }, ...end('max_tokens')]), MODEL, true))
    expect(result.message.content).toEqual([{ type: 'reasoning', text: '' }])
    expect(result.message.source.replayState).toMatchObject({ blocks: [{ type: 'reasoning', signature: 'opaque' }] })
  })

  it.each([
    [start, start],
    [textEvents[1]],
    [start, { ...textEvents[1], index: -1 }],
    [start, textEvents[1], textEvents[1]],
    [start, { type: 'content_block_stop', index: 0 }],
    [start, textEvents[1], textEvents[3], textEvents[3]],
    [start, { ...textEvents[1], content_block: { type: 'text', text: 2 } }],
    [start, textEvents[1], { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'bad' } }],
    [start, { type: 'message_delta', delta: { stop_reason: 'mystery' } }],
    [start, { type: 'message_stop' }],
    [start, textEvents[1], ...end()],
    [start, { type: 'message_delta', delta: {}, usage: { input_tokens: -1 } }],
    [start, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, textEvents[1]],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: '', name: 'read', input: {} } }],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'read', input: [] } }],
  ])('rejects malformed event ordering or fields %#', async (...values) => {
    await expect(chunks(translate(events(values as Record<string, unknown>[]), MODEL, true))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each(['{', '[]'])('refuses completed non-object tool JSON %s without repairing it', async (partial_json) => {
    await expect(chunks(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]), MODEL, true))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses unsupported response content, empty responses and premature EOF', async () => {
    await expect(chunks(translate(events([start, { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } }]), MODEL, true))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(chunks(translate(events([start, ...end()]), MODEL, true))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunks(translate(events(textEvents.slice(0, -1)), MODEL, true))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

describe('Leaked DSML tool calls', () => {
  // Verbatim shape from a deepseek-flash reply that the service returned as text.
  const leaked = '先只恢复已落盘状态。\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="begin_workflow">\n'
    + '<｜｜DSML｜｜ parameter name="caseId" string="true">3a5a9d7d</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  const text = (value: string, reason = 'end_turn') => [start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
    { type: 'content_block_stop', index: 0 }, ...end(reason)]

  it('retries a stop whose only action is tool-call markup returned as text', async () => {
    await expect(chunks(translate(events(text(leaked)), MODEL, true))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunks(translate(events(text('<｜DSML｜function_calls>\n<｜DSML｜invoke name="read">')), MODEL, true)))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    // Observed after a tool error: the opening tag alone already marks the leak.
    await expect(chunks(translate(events(text('先对账该操作回执。\n\n<｜｜DSML｜｜tool_calls>')), MODEL, true)))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('keeps quoted markup, plain mentions and real tool calls as ordinary output', async () => {
    for (const value of ['```\n' + leaked + '\n```', 'DSML is the DeepSeek tool-call markup.']) {
      const result = await chunks(translate(events(text(value)), MODEL, true))
      expect(result.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }
    const withTool = [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: leaked } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'begin_workflow', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 }, ...end('tool_use')]
    expect((await chunks(translate(events(withTool), MODEL, true))).at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('reports markup from a request without tools as a distinct non-retried failure', async () => {
    // Verbatim reply after a native quarantine removed every tool from the request.
    const withoutTools = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="glob">\n'
      + '<｜｜DSML｜｜ parameter name="pattern" string="true">**/*hFUHSlTJ0zHQku78JvVl9237*</｜｜DSML｜｜ parameter>\n'
      + '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
    const reasoned = [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Inspect the receipt first.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: withoutTools } },
      { type: 'content_block_stop', index: 1 }, ...end()]
    await expect(chunks(translate(events(reasoned), MODEL, false))).rejects.toMatchObject({
      code: 'TOOL_MARKUP_WITHOUT_TOOLS', message: 'DeepSeek Messages returned tool-call markup as text while the request declared no tools',
    })
    await expect(chunks(translate(events(text(withoutTools)), MODEL, true))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    const plain = await chunks(translate(events(text('The run is blocked by an unresolved native operation.')), MODEL, false))
    expect(plain.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('SSE framing and provider failures', () => {
  async function read(text: string, bytewise = false) {
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      const end = bytewise ? offset + 1 : bytes.length
      controller.enqueue(bytes.slice(offset, end)); offset = end
    } })
    let activity = 0
    const result = await chunks(translate(parseSse(body, () => { activity++ }), MODEL, true))
    return { result, activity }
  }
  it('frames UTF-8 split at every byte and counts comments and ping as transport activity', async () => {
    const result = await read(`\uFEFF: heartbeat\r\n\r\n${sse([{ type: 'ping' }, ...textEvents]).replaceAll('\n', '\r\n')}`, true)
    expect(result.result).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello 世界' })
    expect(result.activity).toBe(textEvents.length + 2)
  })
  it.each(['data: not-json\n\n', 'data: []\n\n', 'event: ping\ndata: {"type":"other"}\n\n', 'data: {}\n\n'])('rejects malformed SSE %#', async (text) => {
    await expect(read(text)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('does not flush an unterminated terminal event', async () => {
    await expect(read(sse(textEvents).trimEnd())).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
  it('normalizes in-band overloads', async () => {
    await expect(read(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]))).rejects.toMatchObject({ code: 'SERVER' })
  })
  it.each([
    [401, {}, 'AUTH'], [403, {}, 'AUTH'], [402, {}, 'QUOTA'], [429, {}, 'RATE_LIMIT'],
    [400, {}, 'INVALID_REQUEST'], [413, {}, 'INVALID_REQUEST'], [503, {}, 'SERVER'], [404, {}, 'HTTP_404'],
    [undefined, { type: 'authentication_error' }, 'AUTH'], [undefined, { type: 'rate_limit_error' }, 'RATE_LIMIT'],
    [undefined, { type: 'invalid_request_error' }, 'INVALID_REQUEST'], [undefined, {}, 'SERVER'],
    [400, { message: 'maximum context length exceeded' }, 'CONTEXT_WINDOW_EXCEEDED'],
    [400, { message: 'insufficient balance' }, 'QUOTA'],
  ])('classifies status %s and error %j', (status, error, code) => {
    expect(providerError({ error }, status)).toMatchObject({ code })
  })
  it('retains request identity and valid Retry-After without inventing missing counters', () => {
    expect(providerError(null, 429, new Headers({ 'retry-after': '2', 'request-id': 'r1' })).failure).toMatchObject({ requestId: 'r1', providerRetryAfterMs: 2000 })
    expect(providerError({}, 503, new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString(), 'x-request-id': 'r2' })).failure.providerRetryAfterMs).toBeGreaterThan(0)
    expect(providerError({}, 500, new Headers({ 'retry-after': 'invalid', 'x-deepseek-request-id': 'r3' })).failure).toMatchObject({ requestId: 'r3' })
  })
})
