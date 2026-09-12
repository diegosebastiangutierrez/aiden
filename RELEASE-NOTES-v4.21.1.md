# Aiden v4.21.1

This release improves Workbench continuity, dependable execution and visual workflow authoring.

Aiden v4.21.1 is the stable runtime release.

- One-click Auto mode uses the saved autonomy policy for new Workbench tasks while required approvals remain enforced.
- Retry creates a new Job while preserving the original outcome and model binding rules.
- Completed work can be reopened with its recorded Artifacts, Evidence and Verification after restart.
- Required Automation children expose their own outcomes and Evidence; failed required children prevent clean parent success.
- Historical denied actions reconcile truthfully without inventing missing Evidence or repeating execution.
- Browser/session identity, cancellation, late-result fencing, provider/model binding and approval snapshots remain durable.
- Bounded visual workflows compile into the existing Automation contract with typed operations, workspace-safe paths and deterministic validation.
- The runtime preserves the supported Node 20 and Node 22 module boundary.

Aiden Core remains available under AGPL-3.0-only.

Known limitations: real third-party account connections require provider setup and authorization; aggressive terminal resizing may show cosmetic activity-row projection artifacts; Windows installer/uninstall acceptance remains deferred. This release publishes the runtime package only and includes no desktop installer.
