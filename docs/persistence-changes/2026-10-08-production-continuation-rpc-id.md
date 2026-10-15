---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-production-continuation-rpc-id

English | [中文](2026-10-08-production-continuation-rpc-id.zh.md)

## Summary

Adds an optional rpcId to user-approval message sources for uniquely identified workflow continuations, retaining the producer-owned working-directory attribution introduced by the preceding acknowledgement.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-production-continuation-rpc-id
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "07621d6df107e9dc7b4dc16c22e10dd5f2395f13691b54e0fb9f47ecbdb911cb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "0b5885b5b5bc6c3cc92239e137b822db07d7d0e148cceae26f44e039218dfb91"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "22fbf8931a403735e180fe4ee93d006fe6f9996a1af255263bc2f8d3762b0a2e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "d179121f4cb52dc48571eea3bc38c579f90e1556c2a87468d25e9a2ff46fc11b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records retain their meaning. Readers accept the optional rpcId as attribution only; it grants no tool permission and does not authorize replay. The merged source union retains working-directory notices and their declared unknown-attribution policy. Historical native leases without settlement metadata remain unknown. The Session writer version and finalized records are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/workflow/production-studio/tests/conversation.spec.ts packages/workflow/production-studio/tests/native-reconciliation.spec.ts: 62 tests passed. Coverage includes request-id attribution, duplicate continuation refusal, restart reconciliation and unchanged execution attempts. pnpm exec vitest run packages/subagent/subagent/tests: 445 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
