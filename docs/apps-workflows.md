# Apps and reusable workflows

Apps are optional. Chat does not require a Composio key.

In Workbench, open **Apps → Set up GitHub**. The setup link opens the official Composio dashboard. Select your project and open **Settings → API Keys**. Enter the project key into Aiden's protected field. Aiden validates it before replacing any existing configuration; failed validation preserves the working configuration. The field is cleared after each attempt.

A service key configures the connector, not an app account. Complete the separate app authorization, confirm the account, and review its displayed permissions. Use **Disconnect** to revoke Aiden's local account access or **Reconnect** to repair expired access. The normal Aiden integration authorities own account selection and credential storage.

## Create a workflow

1. Select one healthy connected account in **Apps → Workflow Ops**.
2. Select an available action and enter its fields. Do not enter credentials in action inputs.
3. Choose a name and manual-only or daily/weekday scheduling.
4. Preview the exact account, action, pinned versions and input.
5. Save, then open **Automations** to run, pause, or inspect history.

Saving does not execute an action. Each external mutation requires its normal exact-action approval at execution time. A changed account, schema or input invalidates the prior preview. Schedules do not bypass approval and require the local Aiden execution host to be running.

The initial workflow surface supports one exact app action per run. It uses existing Automation revisions, Jobs, Attempts, Effects, Evidence and Verification. Missed and overlapping scheduled runs are skipped, and automatic retries are disabled for these workflows. Repeated delivery of the same creation or manual-run request does not create a second definition or trigger.

## Outcomes and recovery

Open the run from Automation history to inspect its canonical execution and Evidence. A successful read is an external observation, not independent verification of every statement it contains. Mutations require fresh provider readback before they can report verified success.

If a provider response is lost, the effect can remain unknown. Do not repeat an irreversible action to guess whether it worked. Keep the original run and use its reconciliation path; replay is not a substitute for resolving an unknown external outcome. Disconnecting or removing an Automation does not erase its historical execution truth.
