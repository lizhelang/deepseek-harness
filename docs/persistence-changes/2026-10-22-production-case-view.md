---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-production-case-view

English | [中文](2026-10-22-production-case-view.zh.md)

## Summary

Adds an optional case view to the production run carried by production/checkpoint events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-production-case-view
baseline: false
changes:
  - root: "event:production/checkpoint"
    previous: "2026-10-08-production-checkpoints"
    after: "39e76ac94d1a78a83f36a97995b2d33e26a2c0679b628e73efa53a3aa659434b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing checkpoints remain valid because the field is optional and absence means no case projection was observed. The view is display-only: no gate, certificate, routing or replay decision reads it. The event stays ignorable: true, so a same-version reader without this declaration skips it; strict older domain readers may reject new production domain records, as the package README already states.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/workflow/production-studio packages/client/ui-production-studio: 174 tests passed, including persisting and replacing the adapter case view.

<a id="dev-note"></a>
## Dev Note

None.
