# Agent Note: Fixed production conversation graph

Status: implemented

[English](2026-10-22-fixed-production-conversation-graph.md) | 中文

## 问题

[对话持有的生产工作流](2026-10-08-conversation-owned-production-workflow.zh.md)允许用户编辑已绑定运行的未来节点、添加人工决策节点和断点，并为未绑定 Session 保留独立的子 agent 调度器。实际使用中，节点编辑器描述的是 AEA Host 已经控制的工作：模型根据 Host 回执选择动作，而流程编辑只能添加提示词、调整合法步骤的顺序或插入等待。用户发现画布改不了他们关心的内容（搜索深度、制造范围、交付前确认），调度模式又重复了对话运行刻意避免的执行归属。每条编辑路径还需要各自的准入、不可变和继续执行规则。

## 决策

绑定的 AEA 对话始终运行 `createConversationGraph` 构建的流程：基线、几何检查、制造、制造检查、文件检查、目标检查、交付，检查失败后进入修复。每项检查在其 certification 阶段读取 `production_aea_evidence`。`isFixedConversationGraph` 将已保存流程的结构与该流程比较，忽略标签、位置、提示词和工具列表。

服务不再提供 `saveGraph`、`start` 和 `answer`，也不再依赖 subagent 服务。原生租约、未知结果隔离、核对提供方、`pause`、`resume` 和交付证据检查保持不变。

用户对搜索深度和制造范围的偏好由客户端运行策略表单作为普通对话消息发送。模型像读取手动输入一样读取它；Host 冻结的候选上限、参数和交付检查仍约束每个案件。因此表单不改变任何执行权限。

已保存的调度式运行和流程被修改过的对话运行仍可读取和核对。`pause`、`resume` 和准入会带说明地拒绝它们，不会按已不存在的规则运行新操作。

## 考虑过的替代方案

**把编辑器保留在诊断区。** 这会为用户不使用的视图保留全部编辑校验和继续执行规则，也仍会暗示流程控制 AEA 搜索。

**把运行策略变成 Host 强制执行的流程设置。** 搜索深度和制造范围已经属于 AEA Host 的设置和动作。在流程中重复它们会产生第二个所有者，可能与 Host 冻结设置不一致。

**完全删除 Production Studio 准入。** 准入、原生租约和证据检查保证交付可验证、原生工作互斥；回归适配器也读取运行、任务和证据。只删除可编辑和调度式路径。

## 后果

准入只需检查一个流程，因此编辑校验器、子会话激活、并发设置和人工节点逻辑都已删除。用户通过对话和运行策略表单引导案件，而不是通过流程结构。旧的调度式或修改过流程的运行不能继续，其工作需要在新对话中重新开始。删除的 Remote 方法、导出和配置字段记录在[升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.4/production-studio-fixed-graph/guide.zh.md)中。

## 测试

[对话回归](../../../../packages/workflow/production-studio/tests/conversation.spec.ts)覆盖固定流程、AEA 证据检查失败后转入修复，以及调度式和修改过流程的运行只读。[原生租约回归](../../../../packages/workflow/production-studio/tests/native-lease.spec.ts)通过直接工具执行覆盖租约获取、隔离和只读工具。这些无密钥测试只验证软件行为。

## 相关

- [对话持有的生产工作流](2026-10-08-conversation-owned-production-workflow.zh.md)——单执行器绑定、检查点和恢复，这些仍然有效。
- [Production Studio 参考](../../../../packages/workflow/production-studio/README.zh.md)——当前控制方式与限制。
- [Production Studio 客户端](../../../../packages/client/ui-production-studio/README.zh.md)——案件面板与运行策略表单。
