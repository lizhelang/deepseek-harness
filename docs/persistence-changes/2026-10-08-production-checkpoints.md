---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-production-checkpoints

English | [中文](2026-10-08-production-checkpoints.zh.md)

## Summary

Conversation-bound production runs append optional historical checkpoints carrying the same run identity and graph revision as the committed monitoring state.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-production-checkpoints
baseline: false
changes:
  - root: "event:production/checkpoint"
    previous: null
    after: "1585eed5425771c8549b274afdfe1f2d224cc06dce695f1471a90a0faf4bb535"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The checkpoint adds one log-only event without changing existing message derivation or event shapes. It carries optional task admission history, which records the stable lock after human approval without authorizing replay. The producer appends it with `ignorable: true`, allowing same-format Session readers without that event declaration to preserve its opaque payload without adding a model message. This same-version decision covers only the optional Session event, not new fields in the separate production domain. Older strict domain readers are not guaranteed to parse those fields, even when the current reader accepts their absence. Rollback requires a matching pre-update application and data backup. No Session format version bump is required for this additive observation.

<a id="verification"></a>
## Verification

Targeted production runtime tests pass, including same-parent execution, future-node edits, pause without replay, checkpoint append failure recovery, between-receipt disposal, and complete parent-call quiescence. Session envelope regressions and generated persistence catalog checks are run before the final commit. These checks do not certify new Rhino geometry or shop manufacture.

<a id="dev-note"></a>
## Dev Note

None.
