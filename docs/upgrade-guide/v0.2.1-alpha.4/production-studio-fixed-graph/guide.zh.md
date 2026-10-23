---
kind: upgrade-guide
description: "Production Studio 删除调度式运行、流程编辑和人工决策节点；对话流程固定。"
---

# Production Studio 只运行固定的对话流程

[English](guide.md) | 中文

## 变更

`ctx.productionStudio` 不再提供 `saveGraph`、`start` 和 `answer` Remote 方法，`@deepseek-ai/dsh-production-studio` 不再导出 `createProductionGraph`、`validateProductionGraph`、`SaveProductionGraphRequest`、`StartProductionRunRequest` 和 `AnswerProductionRequest`。配置字段 `defaultMaxConcurrent` 和 `subagentProvider` 已删除，此包也不再依赖 subagent 服务。绑定的 AEA 对话始终运行 `createConversationGraph` 返回的流程；客户端用运行策略表单取代流程编辑器，表单发送一条普通对话消息。

已保存的调度式运行和流程被修改过的对话运行仍可读取和核对。`pause` 与 `resume` 会拒绝它们，流程被修改过的对话运行也不再准入新的工具调用。

## 迁移

1. 从 `cordis.yml` 以及 patch、overlay 中 `@deepseek-ai/dsh-production-studio` 条目删除 `defaultMaxConcurrent` 和 `subagentProvider`。
2. 把对 `saveGraph`、`start` 和 `answer` 的调用改成在绑定对话中发送普通对话请求；通过 `registerConversationWorkflow` 注册的可信提供方会把它绑定到一次运行。
3. 用 `createConversationGraph` 替换 `createProductionGraph`；原来用 `validateProductionGraph` 检查流程的地方改用 `isFixedConversationGraph`。
4. 升级前完成或放弃正在进行的调度式运行和改过流程的运行，并在新对话中重新开始这些工作。
5. 加载 profile 确认：启动时没有配置错误，Production Studio 标签显示案件面板和运行策略。
