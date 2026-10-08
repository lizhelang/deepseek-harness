---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-production-continuation-rpc-id

[English](2026-10-08-production-continuation-rpc-id.md) | 中文

## 概述

为 user-approval 消息来源增加可选 rpcId，用于具有唯一身份的工作流继续执行请求。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-production-continuation-rpc-id
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "fb3152ce785a267a88dce7edf550774364f68fda6f3790a5713b8032d0a02e4b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "461637493f4aee23632422039f79bbf09281a62fa5ab8dc7c2acedca7b46e85a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "8ccbf21ab0186887def2414725d29cdee72740ed7d57a71bd0f535703063fe4c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "a19a83e2ecd043392193537ca190ebecfd25754985c1008fc3bc26b35db52038"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 记录仍然有效且语义不变。可选字段记录经过认证的控制请求，不授予工具权限，也不允许重放。生产领域通过已有 JSON 证据字段保留结清证据；没有这些元数据的历史原生租约仍保持未知。

<a id="verification"></a>
## 验证

定向原生对账测试通过，覆盖原调用精确绑定、部分结清写入后的重启、重复继续执行请求拒绝、带请求 ID 的唯一 user-approval 消息以及尝试／执行次数保持不变。真实 Loader 测试确认执行前拒绝可自动结清且不重放工具。

<a id="dev-note"></a>
## 开发备注

无。
