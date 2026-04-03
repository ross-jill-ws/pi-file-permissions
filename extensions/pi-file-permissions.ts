import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import YAML from "yaml";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_RELATIVE_PATH = "./file-permissions.yaml";
const GUARDED_TOOLS = ["read", "write", "edit", "find", "grep", "ls"] as const;
const OVERRIDDEN_TOOL_NAMES = ["read", "write", "edit", "find", "grep", "ls", "bash"] as const;
const BASH_FORBIDDEN_COMMANDS = ["find", "grep", "rg", "ls", "tree", "fd", "ag", "ack", "locate"] as const;

type GuardedToolName = (typeof GUARDED_TOOLS)[number];

// ---------------------------------------------------------------------------
// Config types  (new simplified format)
//
//   domains:
//     - path: /absolute/path
//       permissions: [read, write, find, ls]
//     - path: /another/path
//       permissions: [read]
//
// Only "allow" semantics. Everything not listed is denied.
// If the file doesn't exist, everything is allowed.
// Files directly in the project root always have full permission.
// ---------------------------------------------------------------------------

type RawDomain = {
  path: string;
  permissions: string[];
};

type RawConfig = {
  domains: RawDomain[];
};

type Domain = {
  /** Normalised absolute path (no trailing slash except root) */
  path: string;
  /** Raw path from YAML (for display) */
  raw: string;
  /** Set of allowed tool names for this domain */
  permissions: Set<GuardedToolName>;
};

type PermissionRules = {
  configPath: string;
  domains: Domain[];
};

type LoadedRules = {
  rules: PermissionRules | null;
  fingerprint: string | null;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isSameOrDescendant(parent: string, target: string): boolean {
  return target === parent || target.startsWith(`${parent}/`);
}


// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function validatePermissions(perms: unknown, domainPath: string): Set<GuardedToolName> {
  if (!Array.isArray(perms)) {
    throw new Error(`permissions for "${domainPath}" must be an array`);
  }

  const result = new Set<GuardedToolName>();
  for (const p of perms) {
    if (typeof p !== "string") {
      throw new Error(`permissions for "${domainPath}" must contain only strings`);
    }
    const lower = p.toLowerCase();
    if (!(GUARDED_TOOLS as readonly string[]).includes(lower)) {
      throw new Error(`Unknown permission "${p}" for "${domainPath}". Valid: ${GUARDED_TOOLS.join(", ")}`);
    }
    result.add(lower as GuardedToolName);
  }
  return result;
}

async function loadRules(cwd: string): Promise<LoadedRules> {
  const configPath = path.join(cwd, CONFIG_RELATIVE_PATH);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = YAML.parse(raw) as RawConfig;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Top-level YAML document must be a mapping");
    }

    if (!Array.isArray(parsed.domains)) {
      throw new Error("Expected a 'domains' array in config");
    }

    const domains: Domain[] = [];
    for (const entry of parsed.domains) {
      if (typeof entry !== "object" || entry === null || typeof entry.path !== "string") {
        throw new Error("Each domain must have a 'path' string");
      }

      // Strip trailing glob patterns — paths are always treated as directory prefixes
      const cleanPath = entry.path.replace(/\/\*\*$/, "").replace(/\/\*$/, "");

      domains.push({
        path: normalizePath(cleanPath),
        raw: entry.path,
        permissions: validatePermissions(entry.permissions, entry.path),
      });
    }

    return {
      fingerprint: raw,
      rules: { configPath, domains },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rules: null, fingerprint: null };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Access evaluation
// ---------------------------------------------------------------------------

function getTargetPath(toolName: GuardedToolName, input: Record<string, unknown>, cwd: string): string | null {
  const rawPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path : cwd;

  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      if (typeof input.path !== "string" || input.path.trim().length === 0) {
        return null;
      }
      return normalizePath(path.resolve(cwd, stripAtPrefix(input.path)));

    case "find":
    case "grep":
    case "ls":
      return normalizePath(path.resolve(cwd, stripAtPrefix(rawPath)));
  }
}

function findMatchingDomain(rules: PermissionRules, targetPath: string): Domain | undefined {
  // Find the most specific (longest path) matching domain
  let best: Domain | undefined;
  for (const domain of rules.domains) {
    if (isSameOrDescendant(domain.path, targetPath)) {
      if (!best || domain.path.length > best.path.length) {
        best = domain;
      }
    }
  }
  return best;
}

function evaluateAccess(rules: PermissionRules, toolName: GuardedToolName, targetPath: string, cwd: string): { allowed: boolean; reason?: string } {
  // Everything in the project folder (cwd) has full permission
  if (isSameOrDescendant(normalizePath(cwd), targetPath)) {
    return { allowed: true };
  }

  // ~/.pi always has full permission
  const piDir = normalizePath(path.join(os.homedir(), ".pi"));
  if (isSameOrDescendant(piDir, targetPath)) {
    return { allowed: true };
  }

  const domain = findMatchingDomain(rules, targetPath);
  if (!domain) {
    return {
      allowed: false,
      reason: `Path "${targetPath}" is not within any allowed domain in ${CONFIG_RELATIVE_PATH}`,
    };
  }

  if (!domain.permissions.has(toolName)) {
    return {
      allowed: false,
      reason: `"${toolName}" is not permitted on "${domain.raw}" (allowed: ${[...domain.permissions].join(", ")})`,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Bash validation
// ---------------------------------------------------------------------------

function hasCommandLike(command: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s;|&()])(?:[^\\s;|&()]+/)?${escaped}(?=($|[\\s;|&()]))`);
  return pattern.test(command);
}

function validateBashCommand(command: string): { allowed: boolean; reason?: string } {
  const matched = BASH_FORBIDDEN_COMMANDS.find((name) => hasCommandLike(command, name));
  if (!matched) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `bash may not invoke ${matched}; use the dedicated ${matched === "rg" ? "grep" : matched} tool instead. If that tool is restricted, stop and report the limitation without any workaround.`,
  };
}

// ---------------------------------------------------------------------------
// Summary / prompt helpers
// ---------------------------------------------------------------------------

function buildPermissionSummary(rules: PermissionRules): string {
  const lines = [`File permissions active from ${CONFIG_RELATIVE_PATH}:`];
  for (const domain of rules.domains) {
    lines.push(`  ${domain.raw} → [${[...domain.permissions].join(", ")}]`);
  }
  lines.push("Everything not listed is denied.");
  return lines.join("\n");
}

function buildSystemPromptNotice(rules: PermissionRules): string {
  const domainLines = rules.domains.map(
    (d) => `- ${d.raw}: ${[...d.permissions].join(", ")}`
  );

  return [
    "## File Permission Policy",
    `Permissions are controlled by ${CONFIG_RELATIVE_PATH}.`,
    "Only the following paths and tools are allowed:",
    ...domainLines,
    "",
    "Everything in the current project folder and ~/.pi is always accessible.",
    "Everything else is denied.",
    "If a tool reports a permission restriction, NEVER try a workaround via bash, alternate tools, broader parent directories, globbing, or search/discovery commands.",
    "Stop immediately and report the limitation instead.",
  ].join("\n");
}

function buildToolDescription(baseDesc: string, toolName: GuardedToolName, rules: PermissionRules): string {
  const matching = rules.domains.filter((d) => d.permissions.has(toolName));
  if (matching.length === 0) {
    return `${baseDesc} This tool is not permitted on any configured path.`;
  }

  const paths = matching.map((d) => d.raw).join(", ");
  return `${baseDesc} Allowed paths: ${paths}. All other paths are denied. If denied, stop and report the restriction. Never use bash as a workaround.`;
}

function createPromptGuidelines(toolName: GuardedToolName, rules: PermissionRules): string[] {
  const matching = rules.domains.filter((d) => d.permissions.has(toolName));
  const guidelines = [
    `Only use this tool on paths allowed by ${CONFIG_RELATIVE_PATH}.`,
    "If blocked by permissions, stop and explain the restriction.",
    "Never use bash or another tool as a workaround for a denied path.",
  ];

  if (matching.length > 0) {
    guidelines.push(`Allowed: ${matching.map((d) => d.raw).join(", ")}`);
  }

  return guidelines;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerScopedOverrides(pi: ExtensionAPI, cwd: string, rules: PermissionRules): void {
  const bashTool = createBashTool(cwd);
  const readTool = createReadTool(cwd);
  const writeTool = createWriteTool(cwd);
  const editTool = createEditTool(cwd);
  const findTool = createFindTool(cwd);
  const grepTool = createGrepTool(cwd);
  const lsTool = createLsTool(cwd);

  pi.registerTool({
    ...bashTool,
    description:
      "Execute project-local bash commands. Never use bash for file discovery or content search. Do not invoke find, grep, rg, ls, tree, fd, ag, ack, or locate from bash; use the dedicated tools instead. If those tools are blocked by permissions, stop and report the restriction without any workaround.",
    promptSnippet: "Run project-local CLI commands, but never use bash for search, file discovery, grep, or ls-style listing.",
    promptGuidelines: [
      "Do not call find, grep, rg, ls, tree, fd, ag, ack, or locate from bash.",
      "Use the dedicated read/find/grep/ls tools instead.",
      "If those tools are blocked by permissions, stop and report the limitation instead of trying a workaround.",
    ],
  });

  pi.registerTool({
    ...readTool,
    description: buildToolDescription("Read file contents.", "read", rules),
    promptSnippet: `Read file contents only on permitted paths from ${CONFIG_RELATIVE_PATH}.`,
    promptGuidelines: createPromptGuidelines("read", rules),
  });

  pi.registerTool({
    ...writeTool,
    description: buildToolDescription("Create or overwrite files.", "write", rules),
    promptSnippet: `Create or overwrite files only on permitted paths from ${CONFIG_RELATIVE_PATH}.`,
    promptGuidelines: createPromptGuidelines("write", rules),
  });

  pi.registerTool({
    ...editTool,
    description: buildToolDescription("Edit a single file using exact text replacement.", "edit", rules),
    promptSnippet: `Edit files only on permitted paths from ${CONFIG_RELATIVE_PATH}.`,
    promptGuidelines: createPromptGuidelines("edit", rules),
  });

  pi.registerTool({
    ...findTool,
    description: buildToolDescription("Find files by glob pattern.", "find", rules),
    promptSnippet: `Find filenames only inside permitted paths from ${CONFIG_RELATIVE_PATH}.`,
    promptGuidelines: createPromptGuidelines("find", rules),
  });

  pi.registerTool({
    ...grepTool,
    description: buildToolDescription("Search file contents with ripgrep.", "grep", rules),
    promptSnippet: `Search file contents only inside permitted paths from ${CONFIG_RELATIVE_PATH}.`,
    promptGuidelines: createPromptGuidelines("grep", rules),
  });

  pi.registerTool({
    ...lsTool,
    description: buildToolDescription("List directory contents.", "ls", rules),
    promptSnippet: `List directories only inside permitted paths from ${CONFIG_RELATIVE_PATH}.`,
    promptGuidelines: createPromptGuidelines("ls", rules),
  });

  const activeToolNames = new Set(pi.getActiveTools());
  for (const toolName of OVERRIDDEN_TOOL_NAMES) {
    activeToolNames.add(toolName);
  }
  pi.setActiveTools([...activeToolNames]);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function scopedGuardedTools(pi: ExtensionAPI) {
  let lastFingerprint: string | null | undefined;
  let registeredForCwd: string | undefined;

  async function refreshOverrides(cwd: string): Promise<PermissionRules | null> {
    const { rules, fingerprint } = await loadRules(cwd);
    if (!rules) {
      lastFingerprint = fingerprint;
      return null;
    }

    if (fingerprint !== lastFingerprint || registeredForCwd !== cwd) {
      registerScopedOverrides(pi, cwd, rules);
      lastFingerprint = fingerprint;
      registeredForCwd = cwd;
    }

    return rules;
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const rules = await refreshOverrides(ctx.cwd);
      if (rules) {
        console.log(`${chalk.blue("[file-permissions]")} Loaded ${CONFIG_RELATIVE_PATH}`);
        for (const domain of rules.domains) {
          console.log(`  ${domain.raw} → [${[...domain.permissions].join(", ")}]`);
        }
        console.log("  Everything not listed is denied.");
        console.log(" ");
      } else {
        console.log(`${chalk.blue("[file-permissions]")} ${CONFIG_RELATIVE_PATH} not found — all paths allowed\n`);
      }
    } catch (error) {
      console.log(`${chalk.red("[file-permissions]")} Failed to load ${CONFIG_RELATIVE_PATH}: ${(error as Error).message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(`Failed to load ${CONFIG_RELATIVE_PATH}: ${(error as Error).message}`, "error");
      }
    }
  });

  // before_agent_start: modify system prompt (ctx.ui.notify does not work here)
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const rules = await refreshOverrides(ctx.cwd);
      if (!rules) {
        return undefined;
      }

      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptNotice(rules)}`,
      };
    } catch (error) {
      return undefined;
    }
  });

  // agent_start: notify user about active permissions (UI is ready here)
  pi.on("agent_start", async (_event, ctx) => {
    try {
      const rules = await refreshOverrides(ctx.cwd);
      if (rules) {
        ctx.ui.notify(buildPermissionSummary(rules), "info");
      }
    } catch (error) {
      ctx.ui.notify(`Failed to load ${CONFIG_RELATIVE_PATH}: ${(error as Error).message}`, "error");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    let rules: PermissionRules | null;
    try {
      rules = await refreshOverrides(ctx.cwd);
    } catch (error) {
      const reason = `Failed to parse ${CONFIG_RELATIVE_PATH}: ${(error as Error).message}`;
      if (ctx.hasUI) {
        ctx.ui.notify(reason, "error");
      }
      return { block: true, reason };
    }

    if (!rules) {
      return undefined;
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const bashCheck = validateBashCommand(command);
      if (!bashCheck.allowed) {
        if (ctx.hasUI) {
          ctx.ui.notify(bashCheck.reason ?? "Blocked bash command", "warning");
        }
        return { block: true, reason: bashCheck.reason };
      }
      return undefined;
    }

    if (!GUARDED_TOOLS.includes(event.toolName as GuardedToolName)) {
      return undefined;
    }

    const toolName = event.toolName as GuardedToolName;
    const targetPath = getTargetPath(toolName, event.input as Record<string, unknown>, ctx.cwd);
    if (!targetPath) {
      return { block: true, reason: `${toolName} requires a path` };
    }

    const result = evaluateAccess(rules, toolName, targetPath, ctx.cwd);
    if (!result.allowed) {
      if (ctx.hasUI) {
        ctx.ui.notify(result.reason ?? `Blocked ${toolName} on ${targetPath}`, "warning");
      }
      return { block: true, reason: result.reason };
    }

    return undefined;
  });
}
