---
description: "AEA case monitoring, a compact composer dock, and a run policy form in the current conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-production-studio

English | [中文](README.zh.md)

## Summary

This browser plugin displays one conversation workflow in Chat, Trajectory, Tasks and Run policy, with an expandable monitor above the composer. A bound conversation starts from its normal chat request, without a separate Start action. Tasks and Run policy follow current state; Chat and Trajectory preserve committed checkpoints in log order. Goal, Todo, attachment paste and model selection keep their existing owners. No demonstration tasks or simulated progress enter the application.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

When a run carries an AEA case view, the Tasks view and the composer dock show that case first: the stage bar (intake, baseline, improve, compare, manufacture, delivered), candidate and Host-call budgets, the current best candidate and score, the Host's remaining finish blockers and next actions, one row per actual candidate with its search and manufacturing results, and the selected delivery files with SHA-256. The view is the trusted adapter's projection of the latest Host receipt and certifies nothing. Workflow node rows move under a collapsed diagnostics section. Its buttons queue one ordinary chat message: deliver the current best candidate, improve from a verified candidate, or manufacture a verified candidate that has no manufacturing result. They appear only while the case has no delivery or unknown native result; the Host still decides whether the requested step is legal.

Node diagnostics, shown directly when no run carries a case view, place blocked or unknown results first, then waiting dependencies, running work, paused work and collapsed completed deliveries. Each workpiece is one row. Expanding it exposes Agent branches, then their attempts and observed evidence. Branch pause, resume and unknown-result reconciliation call the actual Host methods with the run revision.

Completed deliveries expose verified files directly, including absolute path, byte count, SHA-256 and a Copy path action. These rows use the completed delivery branch's latest internal `production_aea_evidence` receipt, never model output. Geometry, manufacturing, saved-file and goal verification remain distinct from workshop acceptance and physical refolding.

Resume is offered only for paused work. A blocked conversation offers Pause task and Pause branch for its last settled failed Agent when execution budget remains and no task has an unknown result or pending invocation; the Host rechecks admission before reopening that node. After repairing the capability, pause then resume the same task. Blocked conversations retain their diagnostics and can receive additional chat input without starting another task.

Run policy replaces the former graph editor. It offers three presets (Quick drawings, Standard, Deep optimization) and edits search depth (deliver the baseline, a limited candidate count, or until nothing improves), candidate sources, manufacturing scope (best only or the top few), a confirmation before delivery, and a read-only description of Host scoring. Apply to this conversation queues the policy as one ordinary chat message covering the current and later cases, so it is logged and model-visible; the Host's frozen candidate limit, which the form shows for the latest case, parameters and delivery checks still bound every case. The draft lives in the client store and is not persisted. Sessions without a conversation provider show an explanation instead of the form.

Merely viewing the monitor never starts or replays previous work. The composer dock stays hidden until the conversation has a task and shows a disconnected state when the stream fails. Its counts include waiting and paused workflows; only Host-recorded workflows count, never arbitrary chat messages or tool calls, and historical operations are not imported.

Runs from earlier releases, such as independently scheduled runs or runs with an edited graph, remain visible in diagnostics; the Host rejects pause and resume for them.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/index.ts` owns Cordis effects and slot injections. `production-source.ts` follows current Host state with revision ordering and Session retention. `checkpoint.ts` contributes independent Chat and Trajectory Definitions for `production/checkpoint`, keyed by log sequence rather than run id, so each whole-run event remains independently replayable. Chat renders a localized workflow card. Trajectory uses the [business-record extension](../ui-trajectory/README.md#business-records) to render a localized summary and the checkpoint's complete run in Payload, without a second history stream. `stores.ts` owns only unsent UI state. Components receive props, not Cordis context; copy and CSS use the existing locale and theme owners.

No `./invariant` companion is published: this package owns presentation and explicit user gestures, with no second observation of execution state that could diverge independently. Production execution evidence and admission belong to `dsh-production-studio`.

<a id="model-experience"></a>
## Model Experience

### Case actions and run policy

#### What the model sees

This UI supplies no prompt sections or tool schemas. Case buttons and Apply to this conversation queue one ordinary user chat message with the shown text, which the model sees like any typed message. Pause, resume and reconciliation call `productionStudio.pause`, `productionStudio.resume` and `productionStudio.reconcile` in the [Production Studio](../../workflow/production-studio/README.md) runtime, which owns their admission and model visibility.

#### Token effect

Viewing checkpoints and monitoring add no model tokens. A queued chat message costs the same as typing it. The UI never starts child Agents.

#### KV Cache effect

The UI does not change request history. Historical cards use their own committed Session events; a queued chat message appends to history like any user message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Capability bindings:** This UI does not supply AEA/Rhino capability implementations. The task snapshot lists current Host tools and filesystem capabilities. Unavailable capabilities or unbound objective evidence produce an explicit diagnostic.
- **Run policy reach:** The policy is a chat request, not a Host setting. The model follows it within the Host's frozen candidate limit and delivery checks; the form cannot raise that limit.
- **Trajectory presentation:** Each row describes its own committed checkpoint, not the live task snapshot. The Payload inspector is read-only; opening a historical row never resumes or replays execution.

<a id="dev-note"></a>
### Dev Note

None.

An active conversation with a running or ready recovery branch is summarized by that current branch. Historical blocked branches remain visible; unknown outcomes still take precedence.
