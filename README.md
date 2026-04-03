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

Create a `file-permissions.yaml` in your project root:

```yaml
domains:
  - path: /Users/me/projects/frontend
    permissions: [read, write, edit, find, grep, ls]
  - path: /Users/me/projects/backend
    permissions: [read, find, grep, ls]
  - path: /Users/me/data/reports
    permissions: [read]
```

### Rules

- **Only "allow" semantics** — listed paths get the listed permissions; everything else is denied
- **No config file** — everything is allowed, pi runs normally with no modifications
- **Project root (cwd)** — always has full permission regardless of config
- **`~/.pi`** — always has full permission (pi's own config directory)
- **Trailing globs stripped** — `path: /foo/bar/**` is treated the same as `path: /foo/bar`
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
