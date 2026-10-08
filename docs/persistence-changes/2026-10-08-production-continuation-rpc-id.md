---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-production-continuation-rpc-id

English | [中文](2026-10-08-production-continuation-rpc-id.zh.md)

## Summary

Adds an optional rpcId to user-approval message sources for uniquely identified workflow continuations.

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
    previous: "2026-09-21-user-question-reply"
    after: "fb3152ce785a267a88dce7edf550774364f68fda6f3790a5713b8032d0a02e4b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "461637493f4aee23632422039f79bbf09281a62fa5ab8dc7c2acedca7b46e85a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "8ccbf21ab0186887def2414725d29cdee72740ed7d57a71bd0f535703063fe4c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "a19a83e2ecd043392193537ca190ebecfd25754985c1008fc3bc26b35db52038"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records remain valid and retain their original meaning. The optional field records an authenticated control request; it grants no tool permission and does not authorize replay. The production domain retains settlement evidence in existing JSON evidence fields; historical native leases without that metadata remain unknown.

<a id="verification"></a>
## Verification

Focused native reconciliation tests pass, including exact original call binding, restart after partial settlement writes, duplicate continuation refusal, one user-approval message with its request ID, and unchanged attempts/executions. The real Loader test confirms automatic pre-native rejection settlement without tool replay.

<a id="dev-note"></a>
## Dev Note

None.
