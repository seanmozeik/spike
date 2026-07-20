# Security and privacy

Spike deliberately connects a highly capable local agent to iMessage. Its security model is a narrow identity boundary around a powerful configured user, not a sandboxed chatbot for untrusted strangers.

## Trust model

- The configured direct iMessage peer is trusted to instruct Codex.
- All other chats, participants, SMS traffic, and outbound messages are rejected before scheduling.
- The configured working directory, Codex provider, MCP servers, hooks, skills, sandbox, and approval policy define what the agent can reach.
- `danger-full-access` with `approval_policy = "never"` permits unattended local action. Use it only on a Mac, account, and conversation you control.
- `on-request` routes supported permission requests to one persisted iMessage prompt at a time. Exact `/yes` and `/no` replies are bound to the displayed request and fail closed on expiry, delivery failure, or connection loss.

Conversation identity checks limit who can submit work. They do not make instructions from the configured peer benign, and they do not audit third-party MCP servers, hooks, skills, providers, or local commands.

## macOS permissions

Spike may require Full Disk Access to read the Messages database, Automation permission to send through Messages, and optional Accessibility permission for Like acknowledgements. macOS ties grants to executable identity. Replacing Bun or the native helper can invalidate a previous grant.

`spike init --preview` performs no permission checks or mutations. `spike doctor` reads diagnostic state but does not grant or revoke access.

## Stored data

By default, Spike stores data under `~/.config/spike` and its LaunchAgent under `~/Library/LaunchAgents`. The local journal contains message, scheduler, approval, delivery, account-observation, and recovery state. The isolated Codex home can contain authentication material. Treat the entire Spike home as sensitive.

Runtime directories, configuration, database, logs, account snapshots, and the control socket are owner-only. Eligible terminal payloads are redacted after 30 days. Active or unreconciled work may be retained longer. Retention reduces local exposure; it is not secure erasure and does not remove data already sent to Codex, a provider, an MCP server, a hook, a local tool, Messages, backups, or filesystem snapshots.

Spike copies accepted iMessage attachments into `<working_directory>/tmp/attachments` so Codex can read them inside its configured working directory. These copies use content-addressed names and owner-only permissions, but they contain the original file data or, for HEIC images, a JPEG conversion. Treat that directory as sensitive and do not use a shared working directory.

Ordinary logs suppress app-server noise, but bounded diagnostics can still disclose operational context. Never attach a live Spike home, database, log, prompt, Codex home, or account snapshot to a public issue.

## Network and provider boundary

Spike itself is local. Codex and any configured provider, MCP server, hook, or command can use the network according to their own configuration and the selected sandbox. Review those components separately. Spike does not proxy or anonymize their traffic.

## Reporting a vulnerability

Open a [minimal security report](https://github.com/seanmozeik/spike/issues/new) with the affected version, macOS version, installation channel, and a request for a private follow-up channel. Do not put the reproduction, live secrets, personal message contents, credentials, or private paths in the public issue.

Only the latest published Spike release is supported for security fixes. This project is not affiliated with or endorsed by Apple, OpenAI, Nintendo, or any other third party.
