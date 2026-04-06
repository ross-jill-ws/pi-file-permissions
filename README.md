# pi-file-permissions

A [pi](https://github.com/badlogic/pi-mono) extension that enforces path-based file permissions for pi's built-in tools using a simple YAML config.

## Install / Uninstall

```bash
pi install npm:pi-file-permissions
pi remove npm:pi-file-permissions
```

## Background: Pi's Built-in Tools

Pi ships with **four default coding tools** and **three additional tools** (disabled by default):

| Tool | Default | Description |
|------|---------|-------------|
| `bash` | ✅ enabled | Execute shell commands |
| `read` | ✅ enabled | Read file contents |
| `write` | ✅ enabled | Create or overwrite files |
| `edit` | ✅ enabled | Edit files with exact text replacement |
| `find` | ❌ disabled | Find files by glob pattern |
| `grep` | ❌ disabled | Search file contents with ripgrep |
| `ls` | ❌ disabled | List directory contents |

By default, all enabled tools have unrestricted access to the filesystem. This extension adds permission boundaries so you can control which paths each tool can reach.

## How It Works

This extension is designed to do one simple thing: **restrict which paths the LLM's tools can access**. If you don't provide a `file-permissions.yaml` in your project root, nothing happens — pi runs completely normally.

### Why This Matters

Pi's LLM often aggressively searches for files — sometimes scanning from `$HOME` or traversing large directory trees — which can be slow and wasteful. More importantly, when building **focused agents** or **multi-agent systems**, setting clear boundaries on which files each agent can access is critical. You want to define exactly which paths are read-only, which are editable, and which are completely off-limits. This prevents agents from stepping on each other's work and keeps each agent scoped to its responsibility.

Permission control is enforced at three levels:

### 1. System Prompt

On each prompt, the extension appends a **File Permission Policy** section to the system prompt. This tells the LLM upfront which paths are allowed and which tools can access them. It also instructs the LLM to never attempt workarounds (like using `bash` to run `find` or `grep`) when a tool is blocked.

### 2. Tool Descriptions

The extension overrides the built-in tool descriptions to include the allowed paths from your config. This way the LLM sees the restrictions directly in the tool definitions and avoids calling tools on paths it knows are denied.

The `bash` tool description is updated to explicitly forbid invoking file discovery or search commands (`find`, `grep`, `rg`, `ls`, `tree`, `fd`, `ag`, `ack`, `locate`). These should be done through the dedicated tools, which are subject to permission checks.

### 3. Tool Call Blocking

As a hard enforcement layer, the extension intercepts every tool call (`tool_call` event) and checks the target path against the config. If the path is not within an allowed domain, or the tool is not in that domain's permission list, the call is **blocked** before execution. The LLM receives the denial reason as the tool result.

For `bash`, the extension checks the command string for forbidden subcommands (like `find`, `grep`, `ls`, etc.) and blocks them to prevent workarounds.

## Usage

### Option A: `file-permissions.yaml`

Create a `file-permissions.yaml` in your project root:

```yaml
domains:
  - path: /Users/me/projects/frontend
    permissions: [read, write, edit, find, grep, ls]
  - path: /Users/me/projects/backend
    permissions: [read, find, grep, ls]
  - path: ~/data/reports
    permissions: [read]
  - path: ./local-docs
    permissions: [read, find, ls]
```

Each `path` must be a path to a folder or file. The domain covers the path itself and everything under it. Paths can be:

- **Absolute** — `/Users/me/projects/frontend`
- **Relative** — `./local-docs` (resolved against project root)
- **Home directory** — `~/data/reports` (expands `~` to `$HOME`)

### Option B: `persona.yaml` (pi-teammate)

If you're using [pi-teammate](https://github.com/ross-jill-ws/pi-teammate) — a peer-network multi-agent extension for pi — each agent already has a `persona.yaml` in its working directory. You can embed file permissions directly in that file using a `domain` key, eliminating the need for a separate `file-permissions.yaml`:

```yaml
name: "Drew"
provider: "anthropic"
model: "claude-opus-4-6"
description: >
  Fullstack developer. Builds UI components and API integrations.
systemPrompt: >
  You are a senior fullstack developer.
domains:
  - path: /Users/me/projects/frontend
    permissions: [read, write, edit, find, grep, ls]
  - path: /Users/me/projects/shared-lib
    permissions: [read, find, grep]
```

The `domains` array follows exactly the same structure as in `file-permissions.yaml`. `file-permissions.yaml` takes priority if both files are present.

### Rules

- **Only "allow" semantics** — listed paths get the listed permissions; everything else is denied
- **No config file** — everything is allowed, pi runs normally with no modifications
- **Empty `domains`** — `domains:` or `domains: []` means no extra paths are allowed; only the project root and `~/.pi` remain accessible
- **`persona.yaml` without `domains`** — if the key is absent entirely, no restrictions apply (the file is treated as a plain persona config)
- **`file-permissions.yaml` takes priority** — if both files are present and `file-permissions.yaml` is valid, `persona.yaml` is ignored
- **Project root (cwd)** — has full permission **by default**, but an explicit domain that covers it (or any ancestor of it) overrides this default with the domain's own permissions
- **`~/.pi`** — has full permission by default (pi's own config directory); same override rule as above applies
- **Explicit domains beat defaults** — if a configured domain matches a path, that domain's permissions are the source of truth, even when the path lives inside cwd or `~/.pi`
- **Most specific wins** — if a path matches multiple domains, the longest (most specific) path takes precedence

### Available Permissions

| Permission | Tool | Description |
|-----------|------|-------------|
| `read` | read | Read file contents |
| `write` | write | Create or overwrite files |
| `edit` | edit | Edit files with text replacement |
| `find` | find | Find files by glob pattern |
| `grep` | grep | Search file contents |
| `ls` | ls | List directory contents |

## Scope

This extension only controls access for pi's built-in file tools. It does not manage:

- **Skills** — on-demand capability packages loaded by the LLM
- **MCP servers** — external tool servers connected to pi
- **Custom extension tools** — tools registered by other extensions

If you need to control access to skills or MCP servers, install additional extensions designed for those purposes.

## License

MIT
