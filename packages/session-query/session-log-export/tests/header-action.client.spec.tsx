// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import type { SessionLogDownloadHeaderProps } from '../src/client/HeaderAction.tsx'
import { en, zh } from '../src/client/locales.ts'

const SID = 'session-export-header' as SessionId

function bindSnapshot<State>(store: ObservableSnapshot<State>) {
  return function useSnapshot<T>(selector: (state: State) => T): T {
    return useSyncExternalStore(
      listener => store.subscribe(listener),
      () => selector(store.getSnapshot()),
    )
  }
}

function bench(feedbackAvailable = false, locale = en) {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const request = vi.fn((sessionId: SessionId) => controller.download(sessionId))
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const openFeedback = vi.fn()
  const feedback = createSnapshotStore(feedbackAvailable)
  const useSessionLogDownload = bindSnapshot(controller.store)
  const props = {
    sessionId: SID,
    useSessions: (selector: (state: object) => unknown) => selector({ byId: { [SID]: { displayTitle: 'Exact conversation', cwd: '/workspace/project' } } }),
    useSessionLogDownload,
    useFeedbackAvailable: bindSnapshot(feedback),
    openFeedback,
    request,
    dismiss,
    t: (key: keyof typeof en): string => locale[key],
  } as unknown as SessionLogDownloadHeaderProps
  const view = render(<SessionLogDownloadHeaderAction {...props} />)
  return { controller, request, openFeedback, feedback, view }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Session export Header action', () => {
  it.each([en, zh])('copies only the Session location fields and reports clipboard success', async (locale) => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const b = bench(false, locale)
    fireEvent.click(b.view.getByRole('button', { name: locale['header.more'] }))
    fireEvent.click(b.view.getByRole('menuitem', { name: locale['menu.reference'] }))
    expect(await b.view.findByRole('dialog', { name: locale['reference.copied'] })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`Session ID: ${SID}`))
    const text = writeText.mock.calls[0]?.[0]
    expect(text).toContain(`${locale['reference.title']}: Exact conversation`)
    expect(text).toContain(`${locale['reference.workspace']}: /workspace/project`)
    expect(text?.split('\n').at(-1)).toBe(`${locale['reference.archive']}: dsh-session-${SID}.zip`)
    expect(text).not.toContain(locale['reference.scope'])
    expect(text).toContain(`#session=${SID}`)
    expect(text).toContain(`sessionId=${SID}&includeDescendants=true`)
    expect(b.request).not.toHaveBeenCalled()
  })

  it('offers manual copying when the clipboard rejects the reference', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Copy conversation reference' }))
    expect(await b.view.findByRole('dialog', { name: en['reference.failed'] })).toBeTruthy()
    const text = (b.view.getByRole('textbox') as HTMLTextAreaElement).value
    expect(text).toContain(`Session ID: ${SID}`)
    expect(text).not.toContain(en['reference.scope'])
  })

  it('opens Session feedback and closes the menu without starting a download', () => {
    const b = bench(true)
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Feedback' }))
    expect(b.openFeedback).toHaveBeenCalledWith(SID)
    expect(b.request).not.toHaveBeenCalled()
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it('keeps export available without the feedback plugin', () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.queryByRole('menuitem', { name: 'Feedback' })).toBeNull()
    expect(b.view.getByRole('menuitem', { name: 'Download session log' })).toBeTruthy()
  })

  it('updates the open menu when feedback becomes available, unloads, and reloads', () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.queryByRole('menuitem', { name: 'Feedback' })).toBeNull()

    act(() => { b.feedback.set(true) })
    expect(b.view.getByRole('menuitem', { name: 'Feedback' })).toBeTruthy()
    act(() => { b.feedback.set(false) })
    expect(b.view.queryByRole('menuitem', { name: 'Feedback' })).toBeNull()
    expect(b.view.getByRole('menuitem', { name: 'Download session log' })).toBeTruthy()

    act(() => { b.feedback.set(true) })
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Feedback' }))
    expect(b.openFeedback).toHaveBeenCalledWith(SID)
    expect(b.request).not.toHaveBeenCalled()
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it('opens the more-actions menu and downloads through the shared controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'More actions' })
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Download session log' }))
    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID) })
    expect(b.view.queryByRole('menuitem', { name: 'Download session log' })).toBeNull()
    expect(await b.view.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
  })

  it('closes the menu on Escape without downloading', () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.getByRole('menuitem', { name: 'Download session log' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('menuitem', { name: 'Download session log' })).toBeNull()
    expect(b.request).not.toHaveBeenCalled()
  })

  it('disables the download row while either entry path downloads this Session', async () => {
    const b = bench(true)
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const useSessionLogDownload = bindSnapshot(controller.store)
    b.view.rerender(<SessionLogDownloadHeaderAction {...({
      sessionId: SID,
      useSessions: (selector: (state: object) => unknown) => selector({ byId: { [SID]: { displayTitle: 'Exact conversation', cwd: '/workspace/project' } } }),
      useSessionLogDownload,
      useFeedbackAvailable: bindSnapshot(b.feedback),
      openFeedback: b.openFeedback,
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      t: (key: keyof typeof en): string => en[key],
    } as unknown as SessionLogDownloadHeaderProps)} />)

    const download = controller.download(SID)
    const button = b.view.getByRole('button', { name: 'More actions' })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    fireEvent.click(button)
    const item = b.view.getByRole('menuitem', { name: 'Download session log' })
    expect((item as HTMLButtonElement).disabled).toBe(true)
    expect((b.view.getByRole('menuitem', { name: 'Feedback' }) as HTMLButtonElement).disabled).toBe(false)
    release(new Response('zip'))
    await download
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
    expect((item as HTMLButtonElement).disabled).toBe(false)
  })
})
