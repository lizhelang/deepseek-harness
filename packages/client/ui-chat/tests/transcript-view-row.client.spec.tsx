// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewRow, type TranscriptViewRowProps } from '../src/client/settings/TranscriptViewRow.tsx'
import { PerformanceUsageRow } from '../src/client/settings/PerformanceUsageRow.tsx'
import { DEFAULT_MODEL_PRICES, type LinkOpening, type PerformanceUsageMode, type TranscriptViewMode } from '../src/chat-settings.ts'
import { LinkOpeningRow } from '../src/client/settings/LinkOpeningRow.tsx'
import { en, zh } from '../src/client/locale.ts'
import type { CollapseTiming } from '../src/client/presentation-policy.ts'
import { DEFAULT_TOKEN_PRICING, type TokenPricing } from '../src/client/token-pricing.ts'
import { TokenPricingRow, type TokenPricingRowProps } from '../src/client/settings/TokenPricingRow.tsx'

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

// The resource hook the resources plugin merges into GlobalStandardProps; this row reads no address.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

function mount(mode: TranscriptViewMode = 'standard', dictionary: typeof en | typeof zh = en) {
  const source = createSnapshotStore<TranscriptViewMode>(mode)
  const collapseTiming = createSnapshotStore<CollapseTiming>('completion')
  const setTranscriptView = vi.fn((next: TranscriptViewMode) => { source.set(next) })
  const setCollapseTiming = vi.fn((next: CollapseTiming) => { collapseTiming.set(next) })
  const props: TranscriptViewRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useWorkspaces: emptyWorkspaces(),
    useSessionRetainInfo: () => undefined,
    useResource,
    ...allowAllAccess,
    useTranscriptView: bindSnapshotSelector(source),
    useCollapseTiming: bindSnapshotSelector(collapseTiming),
    setTranscriptView,
    setCollapseTiming,
    t: makeTranslate(dictionary),
  }
  render(<TranscriptViewRow {...props} />)
  return { setTranscriptView, setCollapseTiming, collapseTiming, props }
}

describe('TranscriptViewRow', () => {
  it('explains the preference and shows Standard by default', () => {
    mount()
    expect(screen.getByText('Work details')).toBeDefined()
    expect(screen.getByText('Choose how much detail to show for tool calls')).toBeDefined()
    expect(screen.getByRole('button', { name: /Standard/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    [en, 'Work details', 'When to Collapse Work Details',
      'Choose when to automatically collapse work details', 'On completion', 'On next message'],
    [zh, '工作步骤展示', '工作步骤收起时机', '选择何时自动收起工作步骤', '回答结束后', '下次有新消息时'],
  ] as const)('selects either collapse timing independently with localized labels (%s)', (dictionary, detailTitle, title, description, completion, nextInput) => {
    const b = mount('standard', dictionary)
    const titleElement = screen.getByText(title)
    expect(screen.getByText(detailTitle).compareDocumentPosition(titleElement) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getByText(description)).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    const trigger = screen.getByRole('button', { name: completion })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([completion, nextInput])
    fireEvent.click(screen.getByRole('menuitem', { name: nextInput }))
    expect(b.setCollapseTiming).toHaveBeenLastCalledWith('next-input')
    expect(b.collapseTiming.getSnapshot()).toBe('next-input')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: nextInput }))
    fireEvent.click(screen.getByRole('menuitem', { name: completion }))
    expect(b.setCollapseTiming).toHaveBeenLastCalledWith('completion')
    expect(screen.getByRole('button', { name: completion }).getAttribute('aria-expanded')).toBe('false')
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })

  it('follows timing changes and closes its menu without changing either preference', () => {
    const b = mount()
    act(() => { b.collapseTiming.set('next-input') })
    const trigger = screen.getByRole('button', { name: 'On next message' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.setCollapseTiming).not.toHaveBeenCalled()
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })

  it('returns focus before publishing a timing change', async () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: 'On completion' })
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'On next message' })
    item.focus()
    const focus = vi.spyOn(trigger, 'focus')
    const publish = b.setCollapseTiming.getMockImplementation()!
    let focusedAtPublication = false
    b.setCollapseTiming.mockImplementation((timing) => {
      focusedAtPublication = document.activeElement === trigger
      publish(timing)
    })
    try {
      await act(async () => { fireEvent.click(item) })
      expect(focusedAtPublication).toBe(true)
      expect(document.activeElement).toBe(trigger)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      focus.mockRestore()
    }
  })

  it.each([
    ['compact', 'Compact'],
    ['detailed', 'Detailed'],
    ['verbose', 'Verbose'],
  ] as const)('selects %s and follows the mirrored value', (mode, label) => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Standard/ }))
    expect(screen.queryByRole('menuitem', { name: 'Normal' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Expanded' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    expect(b.setTranscriptView).toHaveBeenCalledWith(mode)
    const trigger = screen.getByRole('button', { name: label })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Compact' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Compact' })).toBeNull()
  })

  it('shows all four work-detail values in Chinese', () => {
    const b = mount('compact', zh)
    expect(screen.getByText('工作步骤展示')).toBeDefined()
    expect(screen.getByText('选择希望看到多少工具调用细节')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '标准' }))
    expect(b.setTranscriptView).toHaveBeenLastCalledWith('standard')
    fireEvent.click(screen.getByRole('button', { name: '标准' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '详细' }))
    expect(b.setTranscriptView).toHaveBeenLastCalledWith('detailed')
    fireEvent.click(screen.getByRole('button', { name: '详细' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '完全展开' }))
    expect(b.setTranscriptView).toHaveBeenLastCalledWith('verbose')
    expect(screen.getByRole('button', { name: '完全展开' })).toBeDefined()
  })

  it('returns focus before publishing a mode change without refocusing after the menu closes', async () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: /Standard/ })
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'Detailed' })
    item.focus()
    const focus = vi.spyOn(trigger, 'focus')
    const publish = b.setTranscriptView.getMockImplementation()!
    let focusedAtPublication = false
    b.setTranscriptView.mockImplementation((mode) => {
      focusedAtPublication = document.activeElement === trigger
      publish(mode)
    })
    try {
      await act(async () => { fireEvent.click(item) })
      expect(focusedAtPublication).toBe(true)
      expect(document.activeElement).toBe(trigger)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      focus.mockRestore()
    }
  })
})


describe('LinkOpeningRow', () => {
  it('follows browser availability without clearing the saved destination', () => {
    const b = mount()
    const browserAvailable = createSnapshotStore(false)
    const source = createSnapshotStore<LinkOpening>('new-tab')
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(browserAvailable)}
      setLinkOpening={vi.fn()}
    />)
    expect(screen.queryByText('Open chat links in')).toBeNull()
    act(() => { browserAvailable.set(true) })
    expect(screen.getByRole('button', { name: 'Default Browser' })).toBeDefined()
    act(() => { browserAvailable.set(false) })
    expect(screen.queryByText('Open chat links in')).toBeNull()
    expect(source.getSnapshot()).toBe('new-tab')
  })

  it.each([
    [en, 'Open chat links in', 'Choose where to open web links', 'In-App Sidebar', 'Default Browser'],
    [zh, '网页链接默认打开方式', '对话中网页链接的打开位置', '应用内侧边栏', '默认浏览器'],
  ] as const)('selects either destination using localized labels (%s)', (dictionary, title, description, sidebar, newTab) => {
    const b = mount('compact', dictionary)
    const source = createSnapshotStore<LinkOpening>('sidebar')
    const setLinkOpening = vi.fn((destination: LinkOpening) => { source.set(destination) })
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(createSnapshotStore(true))}
      setLinkOpening={setLinkOpening}
    />)
    expect(screen.getByText(title)).toBeDefined()
    expect(screen.getByText(description)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: sidebar }))
    fireEvent.click(screen.getByRole('menuitem', { name: newTab }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('new-tab')
    fireEvent.click(screen.getByRole('button', { name: newTab }))
    fireEvent.click(screen.getByRole('menuitem', { name: sidebar }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('sidebar')
    expect(screen.getByRole('button', { name: sidebar }).getAttribute('aria-expanded')).toBe('false')
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })
})

describe('PerformanceUsageRow', () => {
  it('selects compact statistics independently of conversation display', () => {
    const b = mount()
    const source = createSnapshotStore<PerformanceUsageMode>('detailed')
    const setPerformanceUsage = vi.fn((mode: PerformanceUsageMode) => { source.set(mode) })
    render(<PerformanceUsageRow
      {...b.props}
      usePerformanceUsage={bindSnapshotSelector(source)}
      useTokenPricing={selector => selector(DEFAULT_TOKEN_PRICING)}
      setPerformanceUsage={setPerformanceUsage}
    />)
    expect(screen.getByText('Performance & usage')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }))
    expect(setPerformanceUsage).toHaveBeenCalledWith('compact')
    expect(screen.getAllByRole('button', { name: 'Compact' })).toHaveLength(1)
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })
})

describe('TokenPricingRow', () => {
  function mount(initial: TokenPricing = DEFAULT_TOKEN_PRICING) {
    const source = createSnapshotStore<TokenPricing>(initial)
    const setTokenPricing = vi.fn(<K extends keyof TokenPricing>(field: K, value: TokenPricing[K]) => {
      source.set({ ...source.getSnapshot(), [field]: value })
    })
    const props: TokenPricingRowProps = {
      usePanelInfo: selector => selector({ activePanelId: null }),
      useSessions: emptySessions(),
      useSessionStatus: noPendingInteraction(),
      useWorkspaces: emptyWorkspaces(),
      useSessionRetainInfo: () => undefined,
      useResource,
      ...allowAllAccess,
      useTokenPricing: bindSnapshotSelector(source),
      setTokenPricing,
      t: makeTranslate(zh),
    }
    render(<TokenPricingRow {...props} />)
    return { source, setTokenPricing }
  }

  it('lists the default model prices and commits a valid edit on blur', () => {
    const { source, setTokenPricing } = mount()
    expect(screen.getByText('费用估算')).toBeDefined()
    const output = screen.getByLabelText('deepseek-flash 输出') as HTMLInputElement
    expect(output.value).toBe('9')
    fireEvent.change(output, { target: { value: '4.5' } })
    fireEvent.blur(output)
    expect(setTokenPricing).toHaveBeenCalledWith('modelPrices', [
      { ...DEFAULT_MODEL_PRICES[0], output: 4.5 }, DEFAULT_MODEL_PRICES[1],
    ])
    expect(source.getSnapshot().modelPrices[0]?.output).toBe(4.5)
  })

  it('reverts rejected or unchanged drafts and commits on Enter', () => {
    const { setTokenPricing } = mount()
    const input = screen.getByLabelText('deepseek-v4-pro 未缓存输入') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.blur(input)
    expect(input.value).toBe('9')
    fireEvent.change(input, { target: { value: ' 9 ' } })
    fireEvent.blur(input)
    expect(input.value).toBe('9')
    const model = screen.getAllByLabelText('模型 ID')[0] as HTMLInputElement
    fireEvent.change(model, { target: { value: '' } })
    fireEvent.blur(model)
    expect(model.value).toBe('deepseek-flash')
    expect(setTokenPricing).not.toHaveBeenCalled()
    model.focus()
    fireEvent.change(model, { target: { value: 'deepseek-chat' } })
    fireEvent.keyDown(model, { key: 'a' })
    fireEvent.keyDown(model, { key: 'Enter' })
    expect(setTokenPricing).toHaveBeenCalledWith('modelPrices', [
      { ...DEFAULT_MODEL_PRICES[0], model: 'deepseek-chat' }, DEFAULT_MODEL_PRICES[1],
    ])
  })

  it('adds, removes, and restores model prices', () => {
    const { source } = mount()
    fireEvent.click(screen.getByText('添加模型'))
    expect(source.getSnapshot().modelPrices).toHaveLength(3)
    fireEvent.click(screen.getByLabelText('删除 deepseek-flash 的单价'))
    expect(source.getSnapshot().modelPrices.map(price => price.model)).toEqual(['deepseek-v4-pro', 'model-id'])
    fireEvent.click(screen.getByText('恢复默认单价'))
    expect(source.getSnapshot().modelPrices).toBe(DEFAULT_MODEL_PRICES)
  })

  it('shows the exchange rate only for US dollars and rejects a zero rate', () => {
    const { source } = mount()
    expect(screen.queryByLabelText('汇率（元 / 美元）')).toBeNull()
    fireEvent.click(screen.getByText('人民币'))
    fireEvent.click(screen.getByText('美元'))
    expect(source.getSnapshot().costCurrency).toBe('USD')
    const rate = screen.getByLabelText('汇率（元 / 美元）') as HTMLInputElement
    fireEvent.change(rate, { target: { value: '0' } })
    fireEvent.blur(rate)
    expect(rate.value).toBe('7.1')
    fireEvent.change(rate, { target: { value: '7.25' } })
    fireEvent.blur(rate)
    expect(source.getSnapshot().cnyPerUsd).toBe(7.25)
  })
})
