---
description: "Direct AEA conversation workflows, future-node editing, durable execution monitoring, and evidence-checked drawing delivery."
kind: "package-reference"
---

# @deepseek-ai/dsh-production-studio

English | [中文](README.zh.md)

## Summary

Production Studio keeps a bound AEA conversation, task monitor, trajectory and workflow editor on one versioned run. Your chat executes agent steps; supported future-node edits affect later steps without starting another executor. Unbound conversations retain explicitly scheduled runs and child agents. Delivery still requires verified geometry, manufacturing selection, file bytes and hashes, and the recorded delivery conditions.

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

Load this service alongside agent, tool, subagent, filesystem and storage-domain services. A trusted conversation provider binds direct AEA calls to the current graph. Unbound scheduled agent nodes require an in-process `fork` subagent provider; scheduled program nodes use ToolRuntime with its existing approval and sandbox pipeline. This package introduces no model-facing tool schema.

```yaml
- name: '@deepseek-ai/dsh-production-studio'
```

The deployment defaults are 80 executions, three concurrent scheduled tasks, 256 KiB retained evidence, 4 MiB per file readback, 400 history entries and 20 retained runs per conversation. Bound conversation graphs always use one executor. Configure `maxFileBytes` for larger drawings; the [configuration catalog](../../../docs/config-catalog.md) owns accepted deployment fields.

### Bound AEA conversations

Send the model-processing request through the existing chat. The AEA provider binds the first eligible `create_case` call to the actual user objective and source input. That same parent conversation executes the agent nodes; the graph admits and records each actual tool call once. Do not call `start` as a second action: bound profiles reject it, including before their first run.

Use `saveGraph` with the expected graph version to change supported future prompts, tool lists or routes in the same run. A stale save fails and requires reload. An admitted node's executable settings and outgoing routes cannot change; labels and positions may change. Human nodes retain a stable admission record after approval, so later phase changes do not unlock these settings or routes. Edits cannot increase execution or retry budgets, introduce parallel execution, or weaken required delivery checks. Saved changes affect later admitted steps, not a model request or native call already in progress.

`pause`, `resume`, `answer` and `reconcile` require the run ID and current revision. Conversation pause stops admission of the next operation; an already dispatched operation may settle with its known result. A node stopped between known receipts is paused and resumable. A genuinely unresolved invocation is unknown: neither resume nor a human answer grants replay authority. A known failed check is blocked, not an unknown execution result. After an external repair, explicit pause/resume may reopen only the last settled failed agent node when no native execution is leased, no task has an unresolved invocation, and execution budget remains; its result, invocation identity and consumed counters stay unchanged. A blocked pause that fails these conditions rejects without changing the run, its nodes or revision.

Explicit resume and human answers release workflow restrictions and may advance read-only checks. When the run is active with an available agent node and no human wait, unknown result or in-flight call, the service continues the same parent chat. Eligible continuation always uses `steer`, including while an earlier cancellation is settling; it does not choose `inject` from a transient driver status. The continuation preserves the source binding, consumed routes and remaining run budget; it does not start another production run or replay a settled invocation. Saving a graph, reading state and reconnecting never wake an idle driver.

The conversation adapter retains AEA Host's bounded search, required manufacturing evaluations, comparison and repair actions under the original frozen settings and budget. It does not impose the scheduled default's baseline-only `user_requested` shortcut, treat a search score as manufacturing cost, or prove global optimality.

A trusted provider can return `outlet: 'failure', terminal: true` when its Host confirms that no executable continuation remains. The service retains the known receipt and blocks the current node without routing to repair or requesting an after-node human decision. Ordinary failures retain their repair routes and configured human decisions; an unresolved receipt still takes precedence as unknown. Terminal flags inside tool receipt data alone do not change execution.

### Unbound scheduled runs

Without a conversation provider, `start` requires a graph version, objective, JSON input and `goalContractAcknowledged: true`. `input.deliveryGoal` must contain `kind: 'verified-drawings'` and the exact objective as `objectiveText`; optional piece, weld, bend and manufacturing-score limits become frozen acceptance conditions. Scheduled runs capture their graph and input at start; draft edits affect later scheduled runs. Independent scheduled branches and real child agents remain supported.

The default scheduled graph uses the confirmed limited trial: baseline first, with legal `finish_search(reason="user_requested")` when permitted, and necessary optimization after failure or an unmet condition. Its narrow baseline tool list and child-owned evidence remain separate from bound conversation execution. Pause and human decisions affect the chosen scheduled branch; other independent branches continue.

<a id="evidence-and-recovery"></a>
### Evidence and recovery

The required path checks geometry, manufacturing, saved files and the recorded goal before delivery. Host-only `production_aea_evidence` reads the actual AEA ledger and reports, verifies identities and report hashes, and hashes both selected models from binary bytes. Manufacturing selection must bind an actual successful tool receipt to the ledger. Assistant prose, human answers and paths alone cannot certify delivery; graph edits cannot replace or bypass required checks.

Trusted plugins declare exact native tool names through `registerNativeBoundaryProvider(toolNames, { readOnlyToolNames })`; declarations are effect-owned and reference-counted. These calls share a durable exclusive native lease across all execution modes. Exact native declarations take priority over conflicting read-only declarations. Explicit read-only names such as `rhino_api_lookup` do not acquire the lease; undeclared legacy AEA and `rhino_*` names retain conservative native treatment. A trusted native provider records dispatch before native work begins. Pre-dispatch rejection is a known failure; a dispatched error or unresolved native receipt quarantines further native work. Node resource edits cannot remove that lease. `reconcile` accepts only a Session ID and compare-and-set run/node reference; callers cannot supply their own safe flag or receipt.

A trusted plugin registers `registerNativeReconciliationProvider({ id, toolNames, reconcile })` through an effect; an optional `appliesTo(sessionId)` restricts it to its owning preset Sessions. Every selection, including after an awaited Host read, requires exactly one matching provider. DSH supplies the original Session call/result events, SHA-256 of the raw argument text, run, task and native lease. The provider reads its authoritative Host ledger without executing tools and returns the exact Session/call/tool/hash identity, outcome (`rejected_before_native`, `completed` or `unknown`), receipt and evidence. Missing events, identity disagreement, duplicate provider matches and stale references retain quarantine. Completed execution grants no engineering certificate. Manual reconciliation pauses the same node; explicit resume preserves its consumed attempts and executions. A newly logged error with an authenticated pre-native rejection automatically settles before the next prompt and lets the same conversation continue from that error without replaying it.

Authenticated controllers may supply `resume(sessionId, ref, { requestId, text })` for an idle paused conversation with an empty inbox and no native lease. The UUID, text and generated message ID are checkpointed before the sole continuation message is steered; its source is `user-approval` with that `rpcId`. A stale reference or reused UUID refuses resubmission, including after restart or uncertain inbox delivery. The text and complete message share the configured evidence-byte bound. The returned task evidence identifies the admitted request; Session history identifies its eventual consumption. Ordinary resume retains its default continuation text.

A settlement is first persisted on the exact native lease, then attached to the original task and durably checkpointed, and only then releases that lease. A failed intermediate write keeps admission and graph changes blocked. After interruption or restart, retrying reconciliation completes the existing settlement from its recorded identity and evidence without another Host query or tool dispatch. Old native leases without settlement metadata remain readable and unknown; absence of metadata never establishes success.

Large ordinary tool diagnostics can be retained as `data.productionEvidenceReference` instead of repeated inline JSON. The complete observation is first stored in the domain's `evidence` table, bound to its owning Session, SHA-256, UTF-8 byte count and observation metadata. `readEvidence(sessionId, observation)` restores those exact bytes as JSON and rejects missing, altered or foreign references. Reconciliation and named continuation also compact older oversized diagnostic records before applying the unchanged complete retained-byte limit. Objective `production_aea_evidence`, settlement, human and file evidence remain inline. Before an objective check, references are restored and the original full-evidence byte limit and certificate conditions still apply; archival cannot make an oversized proof pass. Blobs are preserved with the domain and currently have no automatic garbage collection.

A failed settlement write does not make an already returned result unknown. The service retains the known receipt and invocation identity in process, blocks new admission until settlement commits, and retries publication rather than redispatching the tool. A continuing domain-write failure is not durability. Once state and its pending history checkpoints commit together, append or durability-flush failure leaves a recoverable metadata outbox and a visible publication error. New operation admission waits for that outbox to publish durably; retry or restart never dispatches native work to recover history.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service serializes graph mutations, admission and settlement while the parent conversation owns each bound tool invocation. Read-only graph checks advance from actual receipts; the ordinary scheduler skips conversation runs. The [conversation-edit validator](src/conversation.ts) protects admitted work and rejects unsupported executors. The [service](src/index.ts) owns lifecycle settlement and publication; the [domain](src/domain.ts) owns saved-state validation and default graphs.

The `production_studio` storage domain owns current execution state keyed by Session ID and a separate global native-lease table. Each changed conversation run and its optional `pendingCheckpoints` outbox commit in the same domain-state write. Publication then appends whole-run `production/checkpoint` events with `ignorable: true` to that same Session. Chat and Trajectory render each historical event at its original sequence; Tasks and Workflow follow current state. Current-state changes never rewrite historical checkpoint cards, and a fork inherits no active run authority.

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

Prompt assembly adds the active run identity, graph version, phase and current agent-node prompt to the parent conversation. It filters registered tools by that node's saved allowlist; ToolRuntime admission enforces the same restriction for direct calls. Workflow checkpoints are log-only and add no model message. An eligible explicit resume or human answer adds recorded continuation context with the existing source kind `user-approval`, attributing the explicit UI approval rather than an ordinary human message with source kind `user`. The context identifies the same run and requires preservation of its source binding, consumed routes and remaining execution budget. Its trailing instruction is `Never repeat a settled invocation or start a second run.`

#### Token effect

The parent incurs its existing chat request costs plus the current workflow instruction and any admitted continuation context. Explicit controls can wake an idle parent for another model request without resetting the run's consumed execution budget. Future prompt edits change later admitted requests; monitoring and checkpoint rendering add no model tokens. Graph budgets bound admitted graph work, not model token usage.

#### KV Cache effect

The normal parent request and system-prompt policy govern reuse. Continuation context enters the logged user-message history without rewriting earlier chat messages; a changed workflow prompt or tool list can affect cache reuse on the next request.

### Scheduled agent-node child input

#### What the model sees

Each scheduled agent node starts a real subagent with its configured prompt or label followed by the frozen objective, JSON input, upstream branch data and human decisions. These are a recorded child user message. The stable trailing instruction is owned by this package:

##### Execution instruction

```markdown
Use actual registered tools. A final assistant message is not delivery evidence. Never modify source code, frozen settings, credentials, or replay an unknown native operation.
```

#### Token effect

Each attempt creates an independent child input. Prompt length depends on the configured node prompt, objective, input, upstream data and accumulated human decisions. Node attempt and run execution budgets bound the number of child starts; evidence retention limits bound stored observations, without limiting the model provider's token usage.

#### KV Cache effect

Each child creates an independent request through its provider. This package does not rewrite earlier parent request tokens. Changes to the node prompt, frozen objective/input, upstream data or human decisions change the appended child request. Provider cache eligibility and eviction are outside this package's contract.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The supported execution modes have distinct limits:

- **Unknown-operation reconciliation** — the owning native provider must bind authoritative evidence to the exact original call. Unregistered tools, ambiguous or missing Session events and unsupported historical Host records remain unknown. Scheduled child invocations without a matching parent-task/lease identity cannot be settled through the conversation resolver. A human answer never substitutes for that evidence.
- **Conversation adapter scope** — agent IDs are limited to `baseline`, `manufacture` and `repair`. Conversation graphs reject parallel branches, custom agent identities, per-node model/provider overrides, program nodes and automatic tools other than read-only AEA evidence checks. Extra supported human decisions do not supply another executor.
- **Continuation eligibility** — explicit resume and answers wake only an active conversation run with a free agent node and no human wait, unknown result or in-flight call. They do not resolve blocked or unknown work by themselves. Graph saves do not wake an idle driver.
- **Unavailable capabilities and storage** — missing real bindings cannot produce simulated success. Binary readback has a file-size limit. Same-version compatibility here applies only to the optional Session log-only event's `ignorable` marker. Older DSH versions are not guaranteed to parse new production-domain fields with their strict readers, even when the new fields are optional. Rollback requires a matching pre-update application and data backup; it is not a promise that an older application can open the new domain state. Domain/outbox commits are not atomic with Session persistence.
- **Acceptance scope** — verified software reports and file hashes establish this workflow's delivery conditions. They do not establish physical manufacture, workshop acceptance, or expert approval of a new part.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

A known terminal failure retains the node’s immutable incoming boundary, so explicit recovery can compare later repair receipts with the original failed state. Normal routed outcomes still consume that boundary; recovery does not reset evidence, attempts or budgets.
