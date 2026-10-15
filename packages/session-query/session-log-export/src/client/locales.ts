/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'header.more': '更多操作',
  'menu.download': '下载 Session 日志',
  'menu.feedback': '反馈',
  'menu.reference': '复制对话引用',
  'reference.title': '对话',
  'reference.workspace': '工作目录',
  'reference.link': '打开对话',
  'reference.export': '下载日志',
  'reference.archive': '导出文件名',
  'reference.scope': '此引用只定位当前 Harness 实例中的对话，不会公开内容或授予访问权限。跨设备分享请下载 Session 日志，再将 ZIP 文件发送给对方或其他 AI。',
  'reference.copied': '对话引用已复制',
  'reference.failed': '无法复制，请选中下方引用手动复制',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.successTitle': 'Session 导出已开始下载',
  'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'header.more': 'More actions',
  'menu.download': 'Download session log',
  'menu.feedback': 'Feedback',
  'menu.reference': 'Copy conversation reference',
  'reference.title': 'Conversation',
  'reference.workspace': 'Working directory',
  'reference.link': 'Open conversation',
  'reference.export': 'Download log',
  'reference.archive': 'Export filename',
  'reference.scope': 'This reference locates a conversation in this Harness instance. It does not publish content or grant access. To share across devices, download the session log and send the ZIP to the recipient or another AI.',
  'reference.copied': 'Conversation reference copied',
  'reference.failed': 'Could not copy. Select the reference below and copy it manually.',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
