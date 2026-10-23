---
kind: upgrade-guide
description: "Production Studio removes scheduled runs, graph editing and human decision nodes; the conversation graph is fixed."
---

# Production Studio runs only the fixed conversation graph

English | [中文](guide.zh.md)

## Change

`ctx.productionStudio` no longer provides the `saveGraph`, `start` and `answer` Remote methods, and `@deepseek-ai/dsh-production-studio` no longer exports `createProductionGraph`, `validateProductionGraph`, `SaveProductionGraphRequest`, `StartProductionRunRequest` or `AnswerProductionRequest`. The `defaultMaxConcurrent` and `subagentProvider` configuration fields are removed, and the package no longer depends on the subagent service. A bound AEA conversation always runs the graph returned by `createConversationGraph`; the client replaces the graph editor with a run policy form that sends an ordinary chat message.

Stored scheduled runs and conversation runs with an edited graph stay readable and reconcilable. `pause` and `resume` reject them, and an edited conversation graph admits no further tool calls.

## Migration

1. Remove `defaultMaxConcurrent` and `subagentProvider` from the `@deepseek-ai/dsh-production-studio` entry in `cordis.yml` and in patches or overlays.
2. Replace calls to `saveGraph`, `start` and `answer` with an ordinary chat request in the bound conversation; a trusted provider registered with `registerConversationWorkflow` binds it to a run.
3. Replace `createProductionGraph` with `createConversationGraph`, and use `isFixedConversationGraph` where code checked a graph with `validateProductionGraph`.
4. Finish or abandon active scheduled or edited runs before upgrading; start that work again in a new conversation.
5. Confirm by loading the profile: it starts without a configuration error, and the Production Studio tab shows the case panel and Run policy.
