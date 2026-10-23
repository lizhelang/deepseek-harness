# Agent Note: Conversation-owned production workflow

Status: implemented

English | [中文](2026-10-08-conversation-owned-production-workflow.zh.md)

## Problem

A normal AEA chat can execute real tools while an independently started production graph remains empty. A monitor that only copies chat progress does not make graph edits control execution. Starting a second scheduler would instead duplicate ownership of the same case and could dispatch native work twice. The four views need a common run identity and real admission rules without another executor.

## Decision

The trusted conversation provider binds an eligible parent-chat call to one production run. Production Studio serializes graph edits, admission and settlement around the same ToolRuntime call; the parent chat remains the only agent executor. Read-only geometry, manufacturing, file and goal checks advance from actual receipts. The ordinary scheduler skips conversation runs and retains its existing child-agent behavior for unbound scheduled runs.

Bound AEA execution follows the existing Host's bounded optimization and manufacturing actions with unchanged frozen settings and budgets. It does not inherit the scheduled default's baseline-only `user_requested` completion shortcut. The provider binds actual user input and case identities; model prose cannot choose another source or certify delivery.

### Future edits and continuation

[Fixed production conversation graph](2026-10-22-fixed-production-conversation-graph.md) supersedes graph editing, human nodes and the unbound scheduler described in this section and above; stored runs that used them stay read-only. The binding, single executor, continuation, checkpoint and recovery rules in this note remain current.

Graph saves compare the expected graph version. Supported future prompts, tool lists and routes change the same run. Executable settings and outgoing routes of admitted nodes remain immutable; labels and canvas positions do not change execution. Human nodes retain a stable admission record after approval, independent of later phase changes, so those changes cannot make admitted settings or consumed routes editable again. Required evidence checks cannot weaken, and execution and retry budgets cannot increase. Tool filtering at prompt assembly is accompanied by enforcement at actual admission.

The current conversation adapter recognizes only `baseline`, `manufacture` and `repair` agent IDs. It rejects parallel routes, custom agent IDs, per-node provider or model overrides, program nodes and automatic operations other than read-only AEA evidence checks. Human nodes can pause admission without supplying another executor.

Explicit resume and human answers release restrictions and may advance read-only checks. They continue the same parent only when its run is active with an available agent node and no human wait, unknown result or in-flight call. Eligible continuation always uses `steer`, including while an earlier cancellation is settling, rather than choosing `inject` from the driver's transient status. This recorded context uses the existing source kind `user-approval` for explicit UI approval, not an ordinary `user` message, and preserves the same run, source binding, consumed routes and remaining execution budget. It grants no authority to replay a settled or unknown invocation. Graph saves, reconnect and state reads never wake work.

### Current state and immutable history

The production storage domain owns current state keyed by the Session ID. Tasks and Workflow consume its committed snapshots. Conversation run revisions append whole-run `production/checkpoint` events to that same Session; Chat and Trajectory render each event by its original log sequence, not by replacing old cards with the latest run state. The checkpoint is log-only and carries `ignorable: true`, allowing same-format readers without this optional event declaration to skip it. It neither adds model context nor promises structural downgrade compatibility.

The optional `pendingCheckpoints` outbox commits with the changed run state in the same production-domain row. A failed Session append therefore leaves the checkpoint available after restart. The Host-only `productionCheckpoints` Session projection folds accepted checkpoints into the greatest revision per run. Its cursor proves acceptance, not durable storage. Publication consults that projection and skips an already accepted run/revision, then awaits `ctx.sessions.flush(session)` and requires `true` before acknowledging and clearing delivered outbox entries. It must flush even when the cursor allowed it to skip append. A `false` result or thrown error retains pending metadata for retry; an acknowledgement-write failure also retains entries without adding duplicate history. This is metadata recovery only; it never redispatches the tool or native operation represented by a checkpoint.

The domain/outbox commit and Session persistence are separate writes. A failed checkpoint append or durability flush is a visible history-publication error, not an unknown native outcome, and new admission waits for pending metadata to publish durably. A known receipt whose domain write fails remains in process with its invocation identity; publication retries never redispatch that operation. A continuing domain-write failure is not durability, and abrupt process loss before settlement commits can still leave an unresolved persisted invocation.

The optional Session event's `ignorable` marker permits same-version readers without that event declaration to skip it. It gives no compatibility guarantee for newly stored production-domain fields: an older strict domain reader can reject those fields even though the current reader accepts their absence. Rollback uses a matching pre-update application and data backup, not an older application parsing new production state.

### Pause and unresolved results

Pause prevents the next conversation operation from starting without discarding the result of an already admitted call. Lifecycle shutdown waits for admitted parent calls to settle before closing state. A conversation node stopped between known receipts pauses and can resume without replay. Only an invocation without a known settlement becomes unknown. A known rejected check remains a failure, and neither a human answer nor resume certifies an unknown operation.

The global native lease remains independent of graph resource settings. A trusted dispatch marker distinguishes rejection before native dispatch from an unresolved dispatched operation. Unknown native work stays quarantined until exact trusted completion evidence is available; no generic reconciliation provider currently supplies that evidence.

## Alternatives considered

**Mirror ordinary chat into an independent task board.** A mirror can display activity but leaves future-node edits disconnected from execution. It cannot meet the requirement that the graph controls subsequent chat steps.

**Start an additional child-agent scheduler for bound conversations.** The existing scheduled executor is retained for explicit unbound runs. Adding it to an already executing parent chat would create two owners of the same native work and another model history instead of four views of one execution.

**Rewrite past events or always render the current run in old cards.** Either choice changes what a historical chat position shows after a later edit. Whole-run, sequence-keyed checkpoints preserve the graph version and state visible at that position without rewriting Session history.

## Consequences

One parent executor gives graph edits actual effect while preserving source input, Host checks and native exclusivity. It also limits conversation graphs to the adapter's completion rules and the parent's current model. The UI cannot promise arbitrary parallel, program or custom-model execution in this mode. Ordinary scheduled runs remain a separate explicit mode rather than a hidden fallback.

The four views describe the same run at different times: current controls follow domain state, while historical views retain committed Session checkpoints. A publication error can temporarily separate those observations and remains visible. Recovery favors preserving known receipts and blocking unresolved mutations over automatic replay or silently declaring completion.

## Testing

[Conversation regressions](../../../../packages/workflow/production-studio/tests/conversation.spec.ts) exercise a real parent chat driver with deterministic tool fixtures, direct-call tool denial, explicit idle-parent continuation with `user-approval`, failed checkpoint publication and lifecycle settlement of known receipts. They also verify that an unresolved invocation refuses resume and a second dispatch. [Native lease regressions](../../../../packages/workflow/production-studio/tests/native-lease.spec.ts) cover native leases and quarantine. These keyless tests establish software behavior, not real Rhino geometry, physical refolding or workshop acceptance. Native and installed-application validation remain the integration owner's responsibility.

## Related

- [Fixed production conversation graph](2026-10-22-fixed-production-conversation-graph.md) — supersedes graph editing, human nodes and scheduled runs.
- [Production Studio reference](../../../../packages/workflow/production-studio/README.md) — consumer controls and current limitations.
- [Production Studio client](../../../../packages/client/ui-production-studio/README.md) — current-state and historical renderers.
- [Event-sourced sessions](2026-06-11-event-sourced-sessions.md) — Session history and synchronous append ownership.
