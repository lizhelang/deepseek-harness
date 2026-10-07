---
description: "Production task monitoring, a compact composer dock, and a typed node editor in the current conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-production-studio

English | [中文](README.zh.md)

## Summary

This browser plugin adds **Tasks** and **Workflow** to the conversation views and an expandable monitor immediately above the existing composer. Chat, trajectory, Goal, Todo, attachment paste and model selection keep their existing owners. The three Studio surfaces share one real `productionStudio` Remote snapshot; no demonstration tasks or simulated progress enter the installed application.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Tasks view places blocked or unknown results first, then human decisions, waiting dependencies, running work, paused work and collapsed completed deliveries. Each workpiece is one row. Expanding it exposes Agent branches, then their attempts and observed evidence. Branch pause, resume, human input and unknown-result reconciliation call the actual Host methods with the run revision.

Completed deliveries expose verified files directly, including absolute path, byte count, SHA-256 and a Copy path action. These rows use the completed delivery branch's latest internal `production_aea_evidence` receipt, never model output. Geometry, manufacturing, saved-file and goal verification are distinct from unverified workshop acceptance and physical refolding. Resume is offered only for paused work; blocked failures show diagnostics and require a corrected capability or a new workflow/run.

Workflow supports movable nodes, click or drag port connections, connection removal, additional Agents/check gates/human gates, canvas pan/zoom, typed-port checks, and explicit node settings. Node properties expose prompts, model routes, allowed tools, native resource serialization, attempt limits, tool arguments, evidence fields, expected JSON values, file paths and before/after breakpoints. The four mandatory proof producers and checks are read-only; supplementary gates remain configurable. Mandatory delivery-proof paths cannot be bypassed; the Host revalidates every submitted draft.

Saving changes the graph draft. Started runs keep their detached starting graph. An unsaved graph, task objective, JSON input or human answer remains a viewing draft and is not replaced by a task-stream update. Start is explicit, requires an objective and task input, and may execute tools or consume model tokens. Viewing the monitor never starts previous work.

The start form states the delivery type and provides optional upper limits for formed pieces, weld actions, bend actions and manufacturing score. Blank limits impose no restriction for that metric. Free-text notes do not replace these objective checks. The stated limited trial starts with the native baseline and delivers when the specified goals pass; only failure or unmet goals require repair and necessary optimization, without a promise of exhaustive search or global optimality. Start requires the user to acknowledge that the displayed conditions and scope fully express the delivery requirements; changing the notes, limits or input clears that acknowledgement. The submitted goal records the exact objective text.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/index.ts` owns Cordis effects and slot injections. `production-source.ts` retains the Session while following actual Host state, stops its stream with the final observer, reconnects after a transport reset, and prevents a delayed read from replacing a newer revision. `stores.ts` owns only unsent UI state. Components receive data and callbacks as props and never access Cordis context. Product copy lives in typed Chinese and English dictionaries; CSS consumes existing semantic theme tokens.

No `./invariant` companion is published: this package owns presentation and explicit user gestures, with no second observation of execution state that could diverge independently. Production execution evidence and graph enforcement belong to `dsh-production-studio`.

<a id="model-experience"></a>
## Model Experience

### Explicit task starts and human answers

#### What the model sees

This UI supplies no prompt sections or tool schemas. Explicit Start calls `productionStudio.start`; human-answer gestures call `productionStudio.answer`. They forward the entered objective, JSON input and answer to [Production Studio](../../workflow/production-studio/README.md), which owns their admission and model visibility.

#### Token effect

Viewing, graph editing and monitoring add no model tokens. An explicitly started graph may invoke child Agents through the production runtime.

#### KV Cache effect

The UI neither reads nor changes request history. The production runtime owns the independent child requests and any admitted answer context.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Capability bindings:** This UI does not supply AEA/Rhino capability implementations. The task snapshot lists current Host tools, subagent and filesystem capabilities. Unavailable capabilities or unbound objective evidence produce an explicit diagnostic.
- **Active workflow versions:** Graph edits apply to future runs. Changing the graph of an active run is intentionally unsupported.

<a id="dev-note"></a>
## Dev Note

None.
