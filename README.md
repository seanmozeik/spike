# spike

Your Codex, in iMessage.

Spike runs Codex app-server on your Mac and connects it to one direct iMessage conversation. The configured peer can be your own address or a separate Apple ID you created for Spike.

## Before you install

Spike is a trusted power tool for a Mac you control. Its useful mode gives Codex access to your files, local CLIs, credentials, MCP servers, hooks, and skills. Read the choices in `spike init`, use a dedicated machine or account where appropriate, and do not expose the configured iMessage address to people you do not trust.

You need:

- macOS with Messages signed in
- Bun 1.3 or newer
- the Codex CLI
- a direct iMessage conversation with the phone number or iMessage email Spike should accept
- Full Disk Access for the Homebrew Bun executable
- permission for Bun to control Messages
- Accessibility permission for the Like helper if you enable Likes

Homebrew installs Bun as a formula dependency. macOS grants Full Disk Access to a specific executable, so a Bun upgrade may require you to approve the new executable again.

## Onboarding

Run:

```nu
spike init
```

To inspect the complete prompt flow without preflight checks, permission requests, authentication,
filesystem writes, LaunchAgent changes, or Messages access, run:

```nu
spike init --preview
```

Preview uses a synthetic conversation and clearly labelled static models. It ends at the review
screen and is safe to run on an already configured Mac.

The Clack flow asks for the exact conversation, working directory, six personality choices, Codex model and reasoning settings, service tier, approval policy, sandbox, and optional personal context. OpenAI authentication uses device login inside Spike's isolated Codex home. It does not copy your main Codex authentication or configuration.

Spike recommends `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` for a headless personal agent. All sandbox modes are available. Permission prompting is still deferred, so `never` is currently the only operational approval policy shown by onboarding.

Nothing is installed before the review screen is confirmed. Spike stages and validates the complete configuration, installs the LaunchAgent, runs `spike doctor`, then waits for a real message and reply in the configured conversation. A failed apply or verification removes the virgin installation.

`spike init` is only for a new installation. Use `spike doctor` for read-only diagnostics if an existing installation is unhealthy; reconfiguration and repair are separate workflows.

## Conversation boundary

Spike accepts only inbound iMessages from the configured direct conversation and canonical peer handle. It checks the chat GUID, peer handle, iMessage service, inbound direction, and one-participant membership when reading Messages, then checks the same identity again before writing to its journal. Other direct messages, group chats, SMS messages, and outbound messages cannot enter the scheduler or Codex context.

## Development

```nu
bun install
just verify
```

The public repository starts from a sanitized source snapshot. Its earlier private history contained machine-specific configuration and personal operational data. No private credentials, account snapshots, Messages databases, logs, or personal configuration are required to build Spike.
