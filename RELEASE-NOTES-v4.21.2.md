# Aiden v4.21.2

Aiden v4.21.2 is the stable runtime release for Web and CLI setup, connections and input reliability.

- Shared capability discovery makes existing Apps, MCP, messaging, developer tools and settings easier to find.
- Model setup distinguishes local inference, API keys and supported subscription authorization.
- Apps requests support protected resumable authorization, cancellation and truthful denial messages. Required approvals remain enforced.
- MCP setup and removal use scoped, expiring confirmations. Provider consent, server trust and execution permissions remain separate.
- Account linking remains optional. Local work does not require a hosted account.
- The optional terminal renderer handles rapid editing and coalesced input while keeping bracketed multiline paste literal until explicit submission.
- Updated HTTP and IMAP dependencies satisfy the packaged dependency contract without vulnerable downgrades. IMAP uses certificate-verified TLS and preserves UID-based trigger identity.

Existing Jobs, Attempts, cancellation, Retry, recovery, Artifacts, Evidence and Verification remain part of the public AGPL-3.0-only runtime.

## Installation

```powershell
npm install -g aiden-runtime@4.21.2
aiden web
```

Run `aiden` for the CLI. Node 20 or Node 22 is required. Back up your Aiden data before upgrading; downgrading the package does not downgrade an updated database schema.

## Known limitations

- This is a runtime package release, not a Windows desktop installer release. Installer/uninstall and startup-performance acceptance remain unresolved.
- GitHub/Gmail and remote MCP require service configuration and user consent. Complete real-service acceptance is not claimed for every integration.
- Hosted optional-email account deployment and proprietary product services are separate and are not included in the public source or package.
- macOS/Ubuntu physical testing and local-model inference acceptance remain deferred.
- Some history details are below the activity list and require scrolling. Existing terminal resize cosmetic limitations remain.

No proprietary vertical implementation, private evaluation material or user credentials are included.
