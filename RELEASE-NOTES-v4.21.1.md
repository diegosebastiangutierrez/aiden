# Aiden v4.21.1 — release preparation

This patch release improves the reliability of completed work, Retry, and Automations.

- Retry creates new work while preserving the original outcome. Users can explicitly choose the original model or the selected model.
- Completed work can be reopened with its recorded Artifacts, Evidence, and Verification after restart.
- Required Automation children expose their own outcomes and Evidence. A failed required child prevents a clean parent success.
- Historical denied actions reconcile truthfully without inventing missing Evidence or repeating execution.
- Production dependency chains include the reviewed security updates.

Aiden Core remains available under AGPL-3.0-only. Content Studio is a separately installed private product with its own entitlement and licence terms.

This local candidate has not been published. Desktop installers and Pro activation require their separate acceptance and release approval.
