---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-production-checkpoints

[English](2026-10-08-production-checkpoints.md) | 中文

## 概述

绑定对话的生产流程追加可选历史检查点，与已提交监控状态使用同一运行身份和图版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-production-checkpoints
baseline: false
changes:
  - root: "event:production/checkpoint"
    previous: null
    after: "1585eed5425771c8549b274afdfe1f2d224cc06dce695f1471a90a0faf4bb535"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

检查点只新增日志事件，不改变既有消息推导或事件形状。它携带可选的任务准入历史，记录人工批准后的稳定锁定，不授予重放权限。生产方追加时标记 `ignorable: true`，允许同格式但没有该事件声明的 Session 读取器保留其不透明载荷，不添加模型消息。这个同版本决定只涉及可选 Session 事件，不涉及独立生产领域的新增字段。旧严格领域读取器不保证能够解析这些字段，即使当前读取器允许它们缺省。回退需要匹配的更新前应用与数据备份。该新增观察不要求 Session 格式版本升级。

<a id="verification"></a>
## 验证

定向生产运行回归已通过，涵盖同父对话执行、未来节点编辑、暂停不重放、检查点追加失败恢复、两个回执之间停止及完整父调用退出等待。提交前另跑会话信封回归和生成持久化目录检查。这些测试不证明新 Rhino 几何或车间制造通过。

<a id="dev-note"></a>
## 开发备注

无。
