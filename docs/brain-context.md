# Brain: context you can inspect and control

Open **Brain** in Workbench. It uses Aiden's existing local Learning Ledger; it is not another memory service. The same controls remain available under Privacy.

Choose an available repository or workspace scope before remembering a preference. User-global scope is an explicit choice to share that preference across your own workspaces. No other owner's context is included. Project context is represented by the current repository/workspace identity; arbitrary project IDs cannot be supplied from the browser.

Review an entry to see its source, confidence, lifecycle, update time, expiry, Evidence references and correction history. **Trusted** means admitted under the recorded source policy, not universally correct. Model prose alone is not a trusted source. **Confirm as my context** records your own statement; it does not verify an external claim. Conflicts and stale sources remain visible and are excluded from automatic recall as the authority requires.

Use **Preview matching context** to see the complete entries that fit the normal context budget. This is a current preview, not a claim about a previous task. Context never grants tool permission, approval or execution authority, and the current request takes precedence.

New model-backed Jobs can record selected context IDs and versions in **Active Work → Selected work details**. These references identify the context supplied for work, not proof that a model followed it. Older Jobs without such records are shown as unrecorded. Opening a reference shows the current authorized record, which may have been corrected or deleted since that recorded version.

Correct an entry, stop using it automatically, archive it, or delete its learned content. Deletion removes learned text, stored content versions and retrieval-index content. Audit tombstones and original source Jobs/Evidence remain; deleting learned context does not erase those independent source records or external backups. Deleted text does not return when the index is rebuilt. Export provides the current scoped ledger for your own records.

Do not store passwords, tokens or approval-bypass instructions as context. Capture rejects detected secrets and authority-changing instructions; execution policy remains independent even for admitted context.
