import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconEllipsisOutlineRegular, IconPaperPlaneOutlineRegular, Menu, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import { sessionLogZipFilename } from './controller.ts'
import { SESSION_LOG_EXPORT_ROUTE } from '../routes.ts'
import css from './HeaderAction.module.css'

/** Session download controls with observable feedback availability and a Session feedback action. */
export interface SessionLogDownloadHeaderInjected extends SessionLogDownloadDialogInjected {
  hooks: SessionLogDownloadDialogInjected['hooks'] & { feedbackAvailable: ObservableSnapshot<boolean> }
  /**
   * Open the existing Session feedback draft without recording feedback; no-op after the feedback plugin unloads.
   * @param sessionId - Session whose feedback form to open.
   */
  openFeedback: (sessionId: SessionId) => void
}

/** Session download props plus the optional feedback action. */
export type SessionLogDownloadHeaderProps = SessionLogDownloadDialogProps & InjectFace<SessionLogDownloadHeaderInjected>

/**
 * Render the Session Header menu with copy-reference, download, and optional feedback actions.
 * @param props - Session runtime, download controller, and localized copy.
 * @returns the persistent Header action and Session-scoped reference and download dialogs.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadHeaderProps): ReactNode {
  const { sessionId, useSessions, useSessionLogDownload, useFeedbackAvailable, request, openFeedback, t } = props
  const feedbackAvailable = useFeedbackAvailable(value => value)
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'
  const [open, setOpen] = useState(false)
  const summary = useSessions(state => state.byId[sessionId])
  const [reference, setReference] = useState<{ sessionId: SessionId; text: string; copied: boolean } | null>(null)

  async function copyReference(): Promise<void> {
    const page = new URL(window.location.href)
    const lines = [
      `${t('reference.title')}: ${summary?.displayTitle ?? sessionId}`,
      `Session ID: ${sessionId}`,
      ...summary?.cwd ? [`${t('reference.workspace')}: ${summary.cwd}`] : [],
    ]
    if (page.protocol === 'http:' || page.protocol === 'https:') {
      page.hash = new URLSearchParams({ session: sessionId }).toString()
      const exportUrl = new URL(SESSION_LOG_EXPORT_ROUTE, document.baseURI)
      exportUrl.search = new URLSearchParams({ sessionId, includeDescendants: 'true' }).toString()
      lines.push(`${t('reference.link')}: ${page.href}`, `${t('reference.export')}: ${exportUrl.href}`)
    }
    lines.push(`${t('reference.archive')}: ${sessionLogZipFilename(sessionId)}`)
    const text = lines.join('\n')
    const copied = await writeClipboard(text)
    setReference({ sessionId, text, copied })
  }

  return (
    <>
      <Menu
        open={open}
        align="end"
        dense
        onClose={() => { setOpen(false) }}
        items={[
          { id: 'reference', label: t('menu.reference'), icon: <IconCopyOutlineRegular /> },
          { id: 'download', label: t('menu.download'), icon: <IconDownloadOutlineRegular />, disabled: busy },
          ...feedbackAvailable ? [{ id: 'feedback', label: t('menu.feedback'), icon: <IconPaperPlaneOutlineRegular /> }] : [],
        ]}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'reference') void copyReference()
          else if (id === 'feedback') openFeedback(sessionId)
          else void request(sessionId)
        }}
        anchor={(
          <Button
            size="sm"
            className={css.moreButton}
            aria-label={t('header.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconEllipsisOutlineRegular />
          </Button>
        )}
      />
      <Modal
        className={css.referenceDialog ?? ''}
        contentClassName={css.referenceContent ?? ''}
        open={reference?.sessionId === sessionId}
        onClose={() => { setReference(null) }}
        title={t(reference?.copied ? 'reference.copied' : 'reference.failed')}
        description={t('reference.scope')}
        closeLabel={t('dialog.close')}
        footer={<Button onClick={() => { setReference(null) }}>{t('dialog.close')}</Button>}
      >
        <textarea className={css.reference} data-modal-autofocus readOnly value={reference?.text ?? ''} aria-label={t('menu.reference')} onFocus={(event) => { event.currentTarget.select() }} />
      </Modal>
      <SessionLogDownloadDialog {...props} />
    </>
  )
}
