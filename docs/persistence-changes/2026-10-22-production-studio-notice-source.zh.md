---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-production-studio-notice-source

[English](2026-10-22-production-studio-notice-source.md) | 中文

## 概述

新增 production-studio 消息来源，用于 Production Studio 在未声明工具的请求返回工具调用文本后、重试前记录的提示。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-production-studio-notice-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "ffd6cb2deb5a30e590b516d23844ce77a5717eeba7503ec3731162e14acb9e18"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "df11fd53b83a25456507bf4c8d772c7df52241077f2938f95d6318efa7dea32c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "4f8251c4dd0a52ee2f8e3b6c53015638a14cb028402346bba7aa77609b36ec60"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "abff7de8d79f8eef9081a0b838645c79a28241af94de7a2f22b8acf3f3d8d07b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效且含义不变。新来源 kind 只出现在 user/message 事件，以及收件箱或标题请求中这些消息的副本里。当前和旧版 Session 读取器对 user 消息来源只要求非空字符串 kind，因此会加载该提示、派生出相同的模型可见 user 消息，并把该 kind 视为不透明归属；消费方对未知 kind 走默认分支。该提示不授予任何工具权限，也不授权重放任何调用。Session 写入版本与已定稿记录不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/workflow/production-studio packages/llm/llm-deepseek packages/llm/llm/tests packages/llm/llm-retry：45 个文件、1072 个测试通过，覆盖未声明工具的请求后记录一次提示并重试一次、同一步再次泄漏时不再提示并结束本轮，以及其他失败代码或不受管理的对话不会收到提示。

<a id="dev-note"></a>
## 开发备注

无。
