# Agent Note: Fixed production conversation graph

Status: implemented

English | [中文](2026-10-22-fixed-production-conversation-graph.zh.md)

## Problem

[Conversation-owned production workflow](2026-10-08-conversation-owned-production-workflow.md) let users edit future nodes of a bound run, add human decision nodes and breakpoints, and keep an independent child-agent scheduler for unbound Sessions. In use, the node editor described AEA work that the Host already controls: the model chooses actions from the Host's receipts, while graph edits could only add prompts, reorder legal steps or insert waits. Users found the canvas did not let them change what they cared about (search depth, manufacturing scope, delivery confirmation), and the scheduled mode duplicated execution ownership that conversation runs avoid. Every edit path also needed its own admission, immutability and continuation rules.

## Decision

A bound AEA conversation always runs the graph built by `createConversationGraph`: baseline, geometry check, manufacture, manufacturing check, file check, goal check, delivery, and repair after a failed check. Each check reads `production_aea_evidence` at its certification stage. `isFixedConversationGraph` compares a stored graph's structure with that graph and ignores labels, positions, prompts and tool lists.

The service no longer exposes `saveGraph`, `start` or `answer`, and no longer depends on the subagent service. The native lease, unknown-result quarantine, reconciliation providers, `pause`, `resume` and the delivery evidence checks are unchanged.

User preferences about how far to search and what to manufacture are sent as an ordinary chat message from the client's run policy form. The model reads them like typed input; the Host's frozen candidate limit, parameters and delivery checks still bound each case. The form therefore changes no execution authority.

Stored scheduled runs and conversation runs with an edited graph stay readable and reconcilable. `pause`, `resume` and admission reject them with an explanation, so no new operation runs under rules that no longer exist.

## Alternatives considered

**Keep the editor under a diagnostics section.** It would keep every edit validator and continuation rule alive for a view users did not use, and it would still suggest that the graph controls the AEA search.

**Turn run policy into Host-enforced graph settings.** Search depth and manufacturing scope already belong to AEA Host settings and actions. Duplicating them in the graph would create a second owner that can disagree with the Host's frozen settings.

**Delete Production Studio admission entirely.** Admission, the native lease and the evidence checks are what make delivery verifiable and native work exclusive; the regression adapter also reads runs, tasks and evidence. Only the editable and scheduled paths were removed.

## Consequences

Admission has one graph to check, so the edit validator, child activation, concurrency settings and human-node logic are gone. Users steer a case through chat and the run policy form rather than through graph structure. Old scheduled or edited runs cannot be continued; their work must restart in a new conversation. The removed Remote methods, exports and configuration fields are recorded in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.4/production-studio-fixed-graph/guide.md).

## Testing

[Conversation regressions](../../../../packages/workflow/production-studio/tests/conversation.spec.ts) cover the fixed graph, a failed AEA evidence check routing to repair, and read-only scheduled and edited runs. [Native lease regressions](../../../../packages/workflow/production-studio/tests/native-lease.spec.ts) cover lease acquisition, quarantine and read-only tools through direct tool execution. These keyless tests establish software behavior only.

## Related

- [Conversation-owned production workflow](2026-10-08-conversation-owned-production-workflow.md) — single-executor binding, checkpoints and recovery, which remain current.
- [Production Studio reference](../../../../packages/workflow/production-studio/README.md) — current controls and limitations.
- [Production Studio client](../../../../packages/client/ui-production-studio/README.md) — case panel and run policy form.
