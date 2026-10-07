---
description: "Durable production graph execution, conversation-owned monitoring, and evidence-gated AEA drawing delivery for users and plugin maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-production-studio

English | [中文](README.zh.md)

## Summary

Production Studio runs a versioned graph in an existing Harness conversation. Independent branches execute concurrently; each native AEA invocation uses one durable exclusive lease. A task completes delivery only after the Host verifies geometry, manufacturing selection, actual file bytes and hashes, and the user's confirmed structured delivery conditions. The client renders this state in the conversation's monitor and workflow editor.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Load this service alongside agent, tool, subagent, filesystem and storage-domain services. An in-process `fork` subagent provider is required for agent nodes; program nodes use the existing ToolRuntime, including its approval and sandbox pipeline. This package introduces no model-facing tool schema.

```yaml
- name: '@deepseek-ai/dsh-production-studio'
```

The default deployment limits are 80 total node executions, three concurrent tasks, 256 KiB retained evidence, 4 MiB per file readback, 400 history entries and 20 retained runs per conversation. Configure `maxFileBytes` for larger drawing files. Per-node attempts and per-run execution/concurrency budgets belong to the saved graph; a started run freezes that graph and its input. Changing the draft affects later runs.

### State and controls

`ctx.productionStudio` exposes the same `productionStudio` Remote namespace. `get` and `follow` provide committed snapshots; `saveGraph` uses an expected graph version; `start` requires that version, an objective and input, plus `goalContractAcknowledged: true`. `input.deliveryGoal` must have `kind: 'verified-drawings'` and an `objectiveText` exactly matching the objective. Optional maximum piece, weld, bend and manufacturing-score limits become frozen acceptance conditions. The service rejects missing confirmation or mismatched objectives.

`pause`, `resume`, `answer` and `reconcile` use the run ID and revision, optionally a node ID. Pause affects only that branch's admission and dependencies. A running interruption becomes unknown. Answering a before/after breakpoint releases only that branch; answering a human node preserves upstream objective evidence and cannot certify an unknown native operation. Independent branches continue. A blocked operation needs a corrected draft and a new run; resume accepts paused work, never unknown work.

Snapshots persist in storage domain `production_studio`, independently of Session journal formats. The session table is keyed by the owning Session ID. Native leases use a separate global table. Restart converts in-flight operations to unknown and pauses ready runs. Reading state never restarts old work, and a fork inherits no active run authority.

### Evidence and native boundaries

The protected default path is baseline → geometry → manufacturing → manufacturing check → file check → goal check → delivery. The confirmed goal contract chooses a limited trial: baseline first, delivery when its declared conditions pass, necessary optimization only after failure or an unmet condition. The manufacturing child may record this scope using the existing Host's legal `finish_search(reason="user_requested")` action, then obtain actual manufacturing and comparison receipts. A failed manufacturing or goal check requires legal repair or resumed search within the original budget. This scope establishes software delivery conditions; it does not prove exhaustive search or global optimality. The four required gates use the Host-only `production_aea_evidence` producer. Graph edits cannot replace its producer, selectors, frozen bindings or reconciliation behavior. Additional gates may be configured without replacing required checks.

The baseline child has a narrow tool list: case creation/restoration, workpiece/geometry/candidate consultation, `submit_baseline` and `finish_search`. Its prompt explicitly records the confirmed limited scope after a verified baseline; optimization and manufacturing tools are unavailable at this stage. Only child-owned events after the Session's authoritative live boundary supply new objective evidence; fork-inherited parent receipts cannot bind a new case or certify this attempt.

The producer reads the existing AEA case ledger and reports, validates their identity and report hashes, checks the required geometry and manufacturing records, and reads both selected models as binary bytes to verify their selected SHA-256 values. Manufacturing selection comes from an actual successful AEA tool receipt, bound back to the ledger. Assistant prose, user-supplied receipts and mere file-path presence cannot certify delivery. Actual reports can reject a candidate without making the native outcome unknown.

Program and tool-backed gate arguments are checked against the current scoped tool schema before ToolRuntime dispatch. A schema rejection records a known failure and follows its failure outlet; valid calls still use the existing guarded execution pipeline. An exception after entering a tool body remains unknown unless a trusted native boundary proves that no native dispatch occurred.

The Host serializes recognized AEA and `rhino_*` tool executions across program nodes, agent children and ordinary conversation calls. Node resource settings can add locks; clearing a setting cannot remove the native lease. A trusted provider registers exact mutating tool names with `registerNativeBoundaryProvider`, owns the returned disposer, and awaits `noteNativeDispatch(exec.callId)` immediately before entering native execution. This commits a dispatch marker before native work begins. A rejection before that marker is a known failure that may enter repair; a dispatched error or an explicit unresolved AEA receipt quarantines native execution, including after restart. Providers without the marker contract are handled conservatively.

## Model Experience

### Agent-node child input

#### What the model sees

Each agent node starts a real subagent with its configured prompt or label followed by the frozen objective, JSON input, upstream branch data and human decisions. These are a recorded child user message. The stable trailing instruction is owned by this package:

##### Execution instruction

```markdown
Use actual registered tools. A final assistant message is not delivery evidence. Never modify source code, frozen settings, credentials, or replay an unknown native operation.
```

#### Token effect

Each attempt creates an independent child input. Prompt length depends on the configured node prompt, objective, input, upstream data and accumulated human decisions. Node attempt and run execution budgets bound the number of child starts; evidence retention limits bound stored observations, without limiting the model provider's token usage.

#### KV Cache effect

Each child creates an independent request through its provider. This package does not rewrite earlier parent request tokens. Changes to the node prompt, frozen objective/input, upstream data or human decisions change the appended child request. Provider cache eligibility and eviction are outside this package's contract.

## Known Limitations and Deferred Work

- **Unknown-operation reconciliation** — no generic provider currently binds an interrupted ToolRuntime call ID to the exact completed native receipt. `reconcile` reports this limitation and leaves the operation unknown. A human answer or another mutating tool call cannot release it; inspecting an existing ledger is not automatic authority to replay.
- **Existing AEA completion policy** — this scheduler uses the existing Host's limited-trial scope and legal next actions. It does not replace AEA's search engine with a new native early-stop algorithm or claim best possible cost. A confirmed structured goal stops this graph once all required evidence is available.
- **Unavailable capabilities** — missing program bindings or subagent providers cannot produce simulated success. A deployment must supply real capabilities. Binary file readback is bounded by the configured file-size limit.
- **Acceptance scope** — verified software reports and file hashes establish this workflow's delivery conditions. They do not establish physical manufacture, workshop acceptance, or expert approval of a new part.

<a id="dev-note"></a>
## Dev Note

None.
