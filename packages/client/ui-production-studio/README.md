---
description: "Production task monitoring, a compact composer dock, and a typed node editor in the current conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-production-studio

English | [中文](README.zh.md)

## Summary

This browser plugin displays one conversation workflow in Chat, Trajectory, Tasks and Workflow, with an expandable monitor above the composer. A bound conversation starts from its normal chat request, without a separate Start action. Tasks and Workflow show current execution state; Chat and Trajectory preserve committed checkpoints in log order. Goal, Todo, attachment paste and model selection keep their existing owners. No demonstration tasks or simulated progress enter the application.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Tasks view places blocked or unknown results first, then human decisions, waiting dependencies, running work, paused work and collapsed completed deliveries. Each workpiece is one row. Expanding it exposes Agent branches, then their attempts and observed evidence. Branch pause, resume, human input and unknown-result reconciliation call the actual Host methods with the run revision.

Completed deliveries expose verified files directly, including absolute path, byte count, SHA-256 and a Copy path action. These rows use the completed delivery branch's latest internal `production_aea_evidence` receipt, never model output. Geometry, manufacturing, saved-file and goal verification remain distinct from workshop acceptance and physical refolding.

Resume is offered only for paused work. A blocked conversation offers Pause task and Pause branch for its last settled failed Agent when execution budget remains and no task has an unknown result or pending invocation; the Host rechecks admission before reopening that node. After repairing the capability, pause then resume the same task. Blocked conversations retain their diagnostics and can receive supported future-node edits or additional chat input without starting another task.

Workflow supports node movement, typed port connections, canvas pan/zoom and explicit future-node settings. Bound AEA conversations use the existing baseline, manufacturing and repair Agents, with additional checks or human decisions. They inherit the chat model; provider/model overrides are read-only. Running, completed and unknown nodes cannot change, and execution or attempt budgets cannot increase. Required delivery checks remain read-only and cannot be bypassed; the Host revalidates each save.

AEA workflows default to a three-column responsibility view for the DSH model, Host control and AEA algorithms. Rows follow actual success routes; repair routes remain separately labeled. Only recorded graph tasks carry execution status. Internal AEA steps explain responsibilities and do not assert completion. Each eligible future boundary offers a connected read-only gate insertion, with node settings below; saving retains all required checks. Gates cannot interrupt the inside of one tool call. Nodes and connections remains available for port editing.

The bound editor displays the authoritative current conversation graph and real task phases. Saving changes supported future nodes in the same run, not a second execution. Unsubmitted edits and human answers remain viewing drafts through stream updates; a newer remote graph prompts an explicit reload instead of discarding them. Merely viewing the monitor never starts or replays previous work. The collapsed dock always shows its title and an explicit empty or disconnected state. Its counts include waiting and paused workflows; only Host-recorded workflows count, never arbitrary chat messages or tool calls, and historical operations are not imported.

Sessions without a conversation provider retain the explicit scheduled Start form. It requires an objective, JSON input and acknowledgement of the stated limited-trial delivery conditions. Optional limits cover formed pieces, weld actions, bend actions and manufacturing score; blank limits impose no restriction. This separate form is absent whenever a conversation provider is registered, even before the first run starts.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/index.ts` owns Cordis effects and slot injections. `production-source.ts` follows current Host state with revision ordering and Session retention. `checkpoint.ts` contributes independent Chat and Trajectory Definitions for `production/checkpoint`, keyed by log sequence rather than run id, so each whole-run event remains independently replayable. Chat renders a localized workflow card. Trajectory uses the [business-record extension](../ui-trajectory/README.md#business-records) to render a localized summary and the checkpoint's complete run in Payload, without a second history stream. `stores.ts` owns only unsent UI state. Components receive props, not Cordis context; copy and CSS use the existing locale and theme owners.

No `./invariant` companion is published: this package owns presentation and explicit user gestures, with no second observation of execution state that could diverge independently. Production execution evidence and graph enforcement belong to `dsh-production-studio`.

<a id="model-experience"></a>
## Model Experience

### Conversation workflow edits and human answers

#### What the model sees

This UI supplies no prompt sections or tool schemas. Graph saves and human answers call the same [Production Studio](../../workflow/production-studio/README.md) runtime that controls direct conversation tools. The runtime owns their admission and model visibility. Only unbound sessions expose `productionStudio.start` for independently scheduled work.

#### Token effect

Viewing checkpoints, graph editing and monitoring add no model tokens. Bound conversation work uses the existing chat executor; the UI never starts child Agents. An explicitly scheduled unbound run may invoke child Agents through the production runtime.

#### KV Cache effect

The UI does not change request history. Historical cards use their own committed Session events; the production runtime owns prompts for future-node edits and admitted answers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Capability bindings:** This UI does not supply AEA/Rhino capability implementations. The task snapshot lists current Host tools, subagent and filesystem capabilities. Unavailable capabilities or unbound objective evidence produce an explicit diagnostic.
- **Conversation capabilities:** Bound AEA conversations do not support additional Agent identities or per-node model/provider overrides. The editor disables those choices rather than suggesting that they apply.
- **Trajectory presentation:** Each row describes its own committed checkpoint, not the live task snapshot. The Payload inspector is read-only; opening a historical row never resumes or replays execution.

<a id="dev-note"></a>
### Dev Note

None.

An active conversation with a running or ready recovery branch is summarized by that current branch. Historical blocked branches remain visible; unknown outcomes still take precedence, and scheduled mixed failures remain critical.
