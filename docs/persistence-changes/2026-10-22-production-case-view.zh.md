---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-production-case-view

[English](2026-10-22-production-case-view.md) | 中文

## 概述

为 production/checkpoint 事件携带的生产运行增加可选的案件视图。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-production-case-view
baseline: false
changes:
  - root: "event:production/checkpoint"
    previous: "2026-10-08-production-checkpoints"
    after: "39e76ac94d1a78a83f36a97995b2d33e26a2c0679b628e73efa53a3aa659434b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该字段可选,缺失表示尚未观察到案件投影,因此已有检查点仍然有效。视图仅用于显示,门禁、证书、路由与重放判断都不读取它。事件仍带 ignorable: true,没有此声明的同版本读取器会跳过它;严格的旧领域读取器可能拒绝新的生产领域记录,包 README 已说明这一点。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/workflow/production-studio packages/client/ui-production-studio:174 个测试通过,包括保存并替换适配器案件视图。

<a id="dev-note"></a>
## 开发备注

无。
