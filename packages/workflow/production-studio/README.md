---
description: "Direct AEA conversation workflows on a fixed graph, durable execution monitoring, and evidence-checked drawing delivery."
kind: "package-reference"
---

# @deepseek-ai/dsh-production-studio

English | [中文](README.zh.md)

## Summary

Production Studio keeps a bound AEA conversation, case panel, run policy and trajectory on one run with a fixed graph. Your chat executes every agent step; the service admits each actual tool call and performs the read-only delivery checks. Delivery still requires verified geometry, manufacturing selection, file bytes and hashes, and the recorded delivery conditions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this service alongside agent, tool, filesystem and storage-domain services. A trusted conversation provider binds direct AEA calls to the fixed graph. Without a provider the service only reads and reconciles existing runs. This package introduces no model-facing tool schema.

```yaml
- name: '@deepseek-ai/dsh-production-studio'
```

The deployment defaults are 80 executions, 256 KiB retained evidence, 4 MiB per file readback, 400 history entries and 20 retained runs per conversation. The conversation graph always uses one executor. Configure `maxFileBytes` for larger drawings; the [configuration catalog](../../../docs/config-catalog.md) owns accepted deployment fields.

### Bound AEA conversations

Send the model-processing request through the existing chat. The AEA provider binds the first eligible `create_case` call to the actual user objective and source input. That same parent conversation executes the agent nodes; the graph admits and records each actual tool call once. The graph is fixed: baseline, geometry check, manufacture, manufacturing check, file check, goal check, delivery, and repair after a failed check. Each check reads `production_aea_evidence` at its certification stage. A run policy chosen in the client reaches the model as an ordinary chat message; it does not change the graph, budgets or checks.

`pause`, `resume` and `reconcile` require the run ID and current revision. Conversation pause stops admission of the next operation; an already dispatched operation may settle with its known result. A node stopped between known receipts is paused and resumable. A genuinely unresolved invocation is unknown: resume does not grant replay authority. A known failed check is blocked, not an unknown execution result. After an external repair, explicit pause/resume may reopen only the last settled failed agent node when no native execution is leased, no task has an unresolved invocation, and execution budget remains; its result, invocation identity and consumed counters stay unchanged. A blocked pause that fails these conditions rejects without changing the run, its nodes or revision.

Explicit resume releases workflow restrictions and may advance read-only checks. When the run is active with an available agent node and no unknown result or in-flight call, the service continues the same parent chat. Eligible continuation always uses `steer`, including while an earlier cancellation is settling; it does not choose `inject` from a transient driver status. The continuation preserves the source binding, consumed routes and remaining run budget; it does not start another production run or replay a settled invocation. Reading state and reconnecting never wake an idle driver.

The conversation adapter retains AEA Host's bounded search, required manufacturing evaluations, comparison and repair actions under the original frozen settings and budget. It does not impose a baseline-only `user_requested` shortcut, treat a search score as manufacturing cost, or prove global optimality.

A trusted provider can return `outlet: 'failure', terminal: true` when its Host confirms that no executable continuation remains. The service retains the known receipt and blocks the current node without routing to repair. Ordinary failures retain their repair routes; an unresolved receipt still takes precedence as unknown. Terminal flags inside tool receipt data alone do not change execution.

A provider can also return `caseView`, a display projection of the Host receipt (stage, budgets, candidate results, finish blockers, next actions and selected delivery files). The service stamps the settlement time and stores it as `run.case`, replacing the previous view; an observation without `caseView` keeps it. No gate, certificate, routing or replay decision reads this view.

A known terminal failure retains the node’s immutable incoming boundary, so explicit recovery can compare later repair receipts with the original failed state. Normal routed outcomes still consume that boundary; recovery does not reset evidence, attempts or budgets.

### Retired runs

Earlier releases also supported independently scheduled runs with child agents, graph editing and human decision nodes. Their stored runs remain readable and reconcilable, but `pause` and `resume` reject a scheduled run or a conversation run whose graph differs from the fixed graph. Start new work in a new conversation.

<a id="evidence-and-recovery"></a>
### Evidence and recovery

The required path checks geometry, manufacturing, saved files and the recorded goal before delivery. Host-only `production_aea_evidence` reads the actual AEA ledger and reports, verifies identities and report hashes, and hashes both selected models from binary bytes. The geometry check reads the search report of the ledger's `baselineCandidateId`, the latest verified baseline or repair candidate; a later exploratory improvement attempt does not replace it. Manufacturing selection must bind an actual successful tool receipt to the ledger. Assistant prose and paths alone cannot certify delivery.

Trusted plugins declare exact native tool names through `registerNativeBoundaryProvider(toolNames, { readOnlyToolNames })`; declarations are effect-owned and reference-counted. These calls share a durable exclusive native lease. Exact native declarations take priority over conflicting read-only declarations. Explicit read-only names such as `rhino_api_lookup` do not acquire the lease; undeclared legacy AEA and `rhino_*` names retain conservative native treatment. A trusted native provider records dispatch before native work begins. Pre-dispatch rejection is a known failure; a dispatched error or unresolved native receipt quarantines further native work. `reconcile` accepts only a Session ID and compare-and-set run/node reference; callers cannot supply their own safe flag or receipt.

A trusted plugin registers `registerNativeReconciliationProvider({ id, toolNames, reconcile })` through an effect; an optional `appliesTo(sessionId)` restricts it to its owning preset Sessions. Every selection, including after an awaited Host read, requires exactly one matching provider. DSH supplies the original Session call/result events, SHA-256 of the raw argument text, run, task and native lease. The provider reads its authoritative Host ledger without executing tools and returns the exact Session/call/tool/hash identity, outcome (`rejected_before_native`, `completed` or `unknown`), receipt and evidence. Missing events, identity disagreement, duplicate provider matches and stale references retain quarantine. Completed execution grants no engineering certificate. Manual reconciliation pauses the same node; explicit resume preserves its consumed attempts and executions. A newly logged error with an authenticated pre-native rejection automatically settles before the next prompt and lets the same conversation continue from that error without replaying it.

Authenticated controllers may supply `resume(sessionId, ref, { requestId, text })` for an idle paused conversation with an empty inbox and no native lease. The UUID, text and generated message ID are checkpointed before the sole continuation message is steered; its source is `user-approval` with that `rpcId`. A stale reference or reused UUID refuses resubmission, including after restart or uncertain inbox delivery. The text and complete message share the configured evidence-byte bound. The returned task evidence identifies the admitted request; Session history identifies its eventual consumption. Ordinary resume retains its default continuation text.

A settlement is first persisted on the exact native lease, then attached to the original task and durably checkpointed, and only then releases that lease. A failed intermediate write keeps admission blocked. After interruption or restart, retrying reconciliation completes the existing settlement from its recorded identity and evidence without another Host query or tool dispatch. Old native leases without settlement metadata remain readable and unknown; absence of metadata never establishes success.

Large ordinary tool diagnostics can be retained as `data.productionEvidenceReference` instead of repeated inline JSON. The complete observation is first stored in the domain's `evidence` table, bound to its owning Session, SHA-256, UTF-8 byte count and observation metadata. `readEvidence(sessionId, observation)` restores those exact bytes as JSON and rejects missing, altered or foreign references. Reconciliation and named continuation also compact older oversized diagnostic records before applying the unchanged complete retained-byte limit. Objective `production_aea_evidence`, settlement and file evidence remain inline. Before an objective check, references are restored and the original full-evidence byte limit and certificate conditions still apply; archival cannot make an oversized proof pass. Blobs are preserved with the domain and currently have no automatic garbage collection.

A failed settlement write does not make an already returned result unknown. The service retains the known receipt and invocation identity in process, blocks new admission until settlement commits, and retries publication rather than redispatching the tool. A continuing domain-write failure is not durability. Once state and its pending history checkpoints commit together, append or durability-flush failure leaves a recoverable metadata outbox and a visible publication error. New operation admission waits for that outbox to publish durably; retry or restart never dispatches native work to recover history.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service serializes admission and settlement while the parent conversation owns each bound tool invocation. Read-only graph checks advance from actual receipts. The [service](src/index.ts) owns lifecycle settlement and publication; the [domain](src/domain.ts) owns saved-state validation and the fixed conversation graph.

The `production_studio` storage domain owns current execution state keyed by Session ID and a separate global native-lease table. Each changed conversation run and its optional `pendingCheckpoints` outbox commit in the same domain-state write. Publication then appends whole-run `production/checkpoint` events with `ignorable: true` to that same Session. Chat and Trajectory render each historical event at its original sequence; the case panel follows current state. Current-state changes never rewrite historical checkpoint cards, and a fork inherits no active run authority.

The Host-only Session projection `productionCheckpoints` records the greatest accepted checkpoint revision per run. Its cursor proves that Session accepted the append, not that the event reached durable storage. Publication and restart recovery consult that projection before appending an outbox entry; an already accepted run/revision is not appended again. Before acknowledging and clearing any delivered outbox entries, publication awaits `ctx.sessions.flush(session)` and requires `true`, even when the cursor allowed it to skip append. A `false` result or thrown error retains the pending metadata for retry. An outbox acknowledgement-write failure also retains entries without adding duplicate history. Recovery republishes metadata only, not the corresponding tool or native operation. The domain/outbox commit and Session persistence remain separate writes, not one atomic transaction, and publication errors remain visible.

The native-invocation projection indexes every committed tool call and result independently of active providers. Registering a new native operation after Session replay preserves its original call identity; duplicate identities remain ambiguous and cannot authorize reconciliation.

On stop, the service waits for admitted parent calls to settle before closing its state. Known conversation receipts remain resumable between operations; only an unresolved invocation becomes unknown. Recovery never automatically dispatches either state. The [architecture decision](../../../.agents/notes/implemented/architecture/2026-10-08-conversation-owned-production-workflow.md) records why one executor serves the four views.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Production Studio client](../../client/ui-production-studio/README.md) — current-state controls and historical rendering.
- [Session log](../../core/session/README.md) — optional log-only events and durability checkpoints.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the separate script-workflow engine and generated service declarations.

-----

## Model Experience

### Bound conversation steps

#### What the model sees

Prompt assembly adds the active run identity, graph version, phase and current agent-node prompt to the parent conversation. It filters registered tools by that node's allowlist; ToolRuntime admission enforces the same restriction for direct calls. Workflow checkpoints are log-only and add no model message. An eligible explicit resume adds recorded continuation context with the existing source kind `user-approval`, attributing the explicit UI approval rather than an ordinary human message with source kind `user`. The context identifies the same run and requires preservation of its source binding, consumed routes and remaining execution budget. Its trailing instruction is `Never repeat a settled invocation or start a second run.`

#### Token effect

The parent incurs its existing chat request costs plus the current workflow instruction and any admitted continuation context. Explicit controls can wake an idle parent for another model request without resetting the run's consumed execution budget. Monitoring and checkpoint rendering add no model tokens. Graph budgets bound admitted graph work, not model token usage.

#### KV Cache effect

The normal parent request and system-prompt policy govern reuse. Continuation context enters the logged user-message history without rewriting earlier chat messages; a node change alters the workflow prompt and tool list, which can affect cache reuse on the next request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The conversation workflow has these limits:

- **Unknown-operation reconciliation** — the owning native provider must bind authoritative evidence to the exact original call. Unregistered tools, ambiguous or missing Session events and unsupported historical Host records remain unknown.
- **Fixed graph** — agent IDs are limited to `baseline`, `manufacture` and `repair`, with no parallel branches, per-node model overrides or editable checks. Search depth and manufacturing scope are requested through chat within the Host's frozen limits.
- **Continuation eligibility** — explicit resume wakes only an active conversation run with a free agent node and no unknown result or in-flight call. It does not resolve blocked or unknown work by itself.
- **Unavailable capabilities and storage** — missing real bindings cannot produce simulated success. Binary readback has a file-size limit. Same-version compatibility here applies only to the optional Session log-only event's `ignorable` marker. Older DSH versions are not guaranteed to parse new production-domain fields with their strict readers, even when the new fields are optional. Rollback requires a matching pre-update application and data backup; it is not a promise that an older application can open the new domain state. Domain/outbox commits are not atomic with Session persistence.
- **Acceptance scope** — verified software reports and file hashes establish this workflow's delivery conditions. They do not establish physical manufacture, workshop acceptance, or expert approval of a new part.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
