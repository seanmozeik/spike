# Spike

Spike runs one Codex conversation from one direct iMessage chat on your Mac. The configured peer can be your own address or a separate Apple ID you control.

Spike is a local power tool, not a hosted bot. It can give Codex access to your files, local commands, credentials, MCP servers, and hooks. Read [Security and privacy](SECURITY.md) before installing it.

## Supported release

The packaged `0.0.1` release targets Apple Silicon on macOS 26 or newer. Intel Macs and older macOS releases are not supported by the current archive because it contains an arm64 native helper. Spike also requires:

- [Bun](https://bun.com/docs/installation) 1.3 or newer;
- the [Codex CLI](https://developers.openai.com/codex/cli);
- Messages signed in to iMessage;
- one direct, one-participant iMessage conversation; and
- Xcode Command Line Tools when building from source.

Spike is not affiliated with or endorsed by Apple, OpenAI, Nintendo, or any other third party.

## Permissions to understand first

Spike does not request these permissions until onboarding is applied, but a working installation needs:

- **Full Disk Access** for the exact Bun executable that runs Spike, so it can read `~/Library/Messages/chat.db`;
- **Automation → Messages** for that Bun executable, so it can send replies; and
- optional **Accessibility** access for `spike-like`, if Like acknowledgements are enabled.

macOS grants privacy permissions to a particular executable. Homebrew or Bun upgrades can replace that executable and require a renewed grant. `spike doctor` reports missing access without changing it.

## Install a published release

The release archive and Homebrew formula use the same version, executable name, and checksum. The formula is the supported default:

```nu
brew tap seanmozeik/spike https://github.com/seanmozeik/spike.git
brew install seanmozeik/spike/spike
spike --version
```

To inspect the matching archive instead of installing the formula:

```nu
let version = "0.0.1"
let archive = $"spike-($version).tar.gz"
curl -fL -o $archive $"https://github.com/seanmozeik/spike/releases/download/v($version)/($archive)"
tar -xzf $archive
^$"./spike-($version)/dist/spike" --version
```

The package metadata names `@seanmozeik/spike`, but registry installation is not a supported channel until that package is published. Do not install similarly named packages.

## Configure and start

Preview every onboarding prompt without preflight, permission prompts, authentication, filesystem writes, LaunchAgent changes, or Messages access:

```nu
spike init --preview
```

Apply a new installation:

```nu
spike init
```

Onboarding selects the direct conversation, working directory, response style, model, reasoning settings, service tier, approval policy, sandbox, and optional personal context. OpenAI authentication uses device login inside Spike's isolated Codex home. Spike does not copy your normal Codex authentication or configuration.

Nothing is installed before the review screen is confirmed. Apply writes the configuration, installs the user LaunchAgent, runs diagnostics, and waits for a real round trip in the configured conversation. A failed first installation removes the state it created.

`spike init` is for a new installation. It is not a repair or reconfiguration command.

## Operate Spike

```nu
spike start       # write the current LaunchAgent and start it
spike stop        # stop the LaunchAgent
spike restart     # rewrite the LaunchAgent and restart it
spike status      # compact runtime, turn, account, and approval state
spike doctor      # read-only configuration, permission, journal, and service diagnostics
spike logs        # bounded daemon-log tail
spike accounts    # configured accounts and current observations
spike approvals   # pending and recently resolved permission requests
```

The operator commands accept `--json` for formatted structured output and `--agent` for compact single-line JSON. `spike serve` is the foreground daemon entry point used by launchd; it is not a second installation mode.

If an existing installation is unhealthy, start with:

```nu
spike doctor
spike status
```

## Approval and sandbox choices

For unattended use, onboarding offers `approval_policy = "never"` with `sandbox_mode = "danger-full-access"`. That combination is powerful: Codex can act without asking again inside the trust boundary described below.

Choose `on-request` to route supported Codex permission requests to iMessage. Spike persists one request at a time. Reply with exactly `/yes` or `/no`; extra prose is rejected, requests expire after ten minutes, and a failed delivery or Codex connection fails closed. Approval does not create a session-wide grant.

## Conversation trust boundary

The configured peer is trusted input. Spike accepts only inbound iMessages from the configured direct chat and canonical peer handle. It validates the chat GUID, handle, iMessage service, direction, and one-participant membership before journalling a message, and revalidates membership while running.

Other direct messages, group chats, SMS messages, and outbound messages do not enter the scheduler or Codex context. This boundary does not make malicious instructions from the configured peer safe; it defines who is allowed to instruct the agent.

## Configuration and examples

Spike's own configuration lives at `~/.config/spike/config.toml`. Codex model, provider, MCP, hook, feature, approval, and sandbox settings belong under `~/.config/spike/codex-home/`.

The repository and release archive include fictional, path-safe examples:

- [`examples/spike.config.toml`](examples/spike.config.toml) for the conversation and working directory;
- [`examples/codex/openai.toml`](examples/codex/openai.toml) for OpenAI model, sandbox, and approvals;
- [`examples/codex/custom-provider.toml`](examples/codex/custom-provider.toml), [`ollama.toml`](examples/codex/ollama.toml), and [`lm-studio.toml`](examples/codex/lm-studio.toml) for alternate providers; and
- [`examples/codex/mcp-and-hooks.toml`](examples/codex/mcp-and-hooks.toml) for MCP and hook configuration.

Provider secrets stay in the provider's named environment variable or its own authentication store. Do not put tokens in `config.toml`, prompts, or hook files.

## Upgrade

Upgrade through the same channel used to install Spike, then rewrite the LaunchAgent so it points at the new release:

```nu
brew update
brew upgrade seanmozeik/spike/spike
spike restart
spike doctor
```

An upgrade preserves `~/.config/spike`, including the Spike configuration, prompt, isolated Codex home, account snapshots, and SQLite journal. It does not migrate data into a different `SPIKE_HOME`. Database migrations are additive and run when the new daemon opens the existing journal.

The binary path can change after a Homebrew or Bun upgrade. If Messages access fails afterward, restore Full Disk Access and Automation for the exact Bun executable reported by `which bun`, then rerun `spike doctor` and `spike restart`.

## Local data, retention, and recovery

The default home is `~/.config/spike`:

| Path              | Contents                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `config.toml`     | conversation and runtime configuration                              |
| `prompt.md`       | generated prompt overlay                                            |
| `codex-home/`     | isolated Codex configuration and authentication                     |
| `accounts/`       | optional account snapshots                                          |
| `state/spike.db`  | durable cursor, scheduler, approval, delivery, and recovery journal |
| `logs/daemon.log` | bounded operator diagnostics                                        |
| `run/spike.sock`  | owner-only local control socket                                     |

The LaunchAgent is written to `~/Library/LaunchAgents/com.mozeik.spike.plist`. Runtime directories and sensitive files are owner-only. Eligible terminal payloads are redacted after 30 days; unresolved work remains until it is safe to reconcile or redact. Logs and the journal are local but can still contain sensitive operational context, so do not publish them.

Spike uses its journal to recover persisted work after daemon or app-server restarts. Recovery is designed to suppress duplicate turns and duplicate delivery, but it cannot make macOS, Messages, external providers, hooks, or local tools transactional. Inspect `spike status`, `spike doctor`, and `spike logs` after an interrupted upgrade or prolonged outage.

## Known limits

- Spike runs as a user LaunchAgent. It is unavailable before login and while the Mac is off or asleep.
- A locked session can interrupt Messages or Accessibility automation. Like acknowledgement degrades independently and does not block the final text reply.
- Spike depends on the installed Codex app-server protocol. Upgrade Codex deliberately and run `spike doctor` plus a bounded self-chat check afterward.
- Provider authentication and rate limits remain external constraints. Spike reports account state, but it cannot create capacity or run in the cloud while the Mac is unavailable.
- This release has no GUI, remote administration surface, arbitrary multi-user routing, or guarantee that every third-party MCP server or hook is safe.

## Development and release

```nu
bun install
bun run setup
bun run verify
```

`bun run setup` patches the local TypeScript compiler with Effect diagnostics. `bun run verify` formats, lints, typechecks, tests, and builds the CLI plus native Like helper. Building therefore requires Xcode Command Line Tools even with `--no-formula`.

Create the versioned archive and update its formula checksum with:

```nu
bun run build
```

The public repository is a sanitized source snapshot. Building and testing require no private credentials, account snapshots, Messages database, logs, Vault, Shim, or personal configuration.

Spike is licensed under the [MIT License](LICENSE).
