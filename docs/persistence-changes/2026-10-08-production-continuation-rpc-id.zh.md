---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-production-continuation-rpc-id

[English](2026-10-08-production-continuation-rpc-id.md) | 中文

## 概述

为 user-approval 消息来源添加可选 rpcId，以唯一标识工作流继续请求，同时保留前序确认记录引入的生产方工作目录归属。

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
    previous: "2026-10-13-user-rpc-principal"
    after: "07621d6df107e9dc7b4dc16c22e10dd5f2395f13691b54e0fb9f47ecbdb911cb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "0b5885b5b5bc6c3cc92239e137b822db07d7d0e148cceae26f44e039218dfb91"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "22fbf8931a403735e180fe4ee93d006fe6f9996a1af255263bc2f8d3762b0a2e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "d179121f4cb52dc48571eea3bc38c579f90e1556c2a87468d25e9a2ff46fc11b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 记录保持原意。读取器将可选 rpcId 仅作为归属信息，它不授予工具权限，也不授权重放。合并后的来源联合类型保留工作目录通知及已声明的未知归属策略。缺少结算元数据的历史原生租约仍为 unknown。Session 写入版本与已定版记录保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/workflow/production-studio/tests/conversation.spec.ts packages/workflow/production-studio/tests/native-reconciliation.spec.ts：62 个测试通过，覆盖请求 ID 归属、重复继续拒绝、重启核对以及执行尝试数保持。pnpm exec vitest run packages/subagent/subagent/tests：445 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
