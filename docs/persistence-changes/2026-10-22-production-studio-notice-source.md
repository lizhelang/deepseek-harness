---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-production-studio-notice-source

English | [中文](2026-10-22-production-studio-notice-source.zh.md)

## Summary

Adds the production-studio message source for the notice Production Studio records before retrying a request that declared no tools and returned tool-call text.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-production-studio-notice-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "ffd6cb2deb5a30e590b516d23844ce77a5717eeba7503ec3731162e14acb9e18"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "df11fd53b83a25456507bf4c8d772c7df52241077f2938f95d6318efa7dea32c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "4f8251c4dd0a52ee2f8e3b6c53015638a14cb028402346bba7aa77609b36ec60"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-08-production-continuation-rpc-id"
    after: "abff7de8d79f8eef9081a0b838645c79a28241af94de7a2f22b8acf3f3d8d07b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and keep their meaning. The new source kind appears only on user/message events and in inbox or title-request copies of those messages. Current and older Session readers require only a non-empty string kind for user-message sources, so they load the notice, derive the same model-visible user message, and treat the kind as opaque attribution; consumers fall through unknown kinds. The notice grants no tool permission and does not authorize replay of any invocation. The Session writer version and finalized records are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/workflow/production-studio packages/llm/llm-deepseek packages/llm/llm/tests packages/llm/llm-retry: 45 files and 1072 tests passed, including one notice and one retry after a request without tools, a second leak ending the turn without another notice, and other failure codes or ungoverned conversations receiving no notice.

<a id="dev-note"></a>
## Dev Note

None.
