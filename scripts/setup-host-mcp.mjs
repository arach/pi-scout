#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const HELP_FLAGS = new Set(["--help", "-h"]);
const SUPPORTED_HOSTS = ["codex", "claude"];
const TRUTHY_ENV_PATTERN = /^(1|true|yes|on)$/i;
const SKIP_ENV_KEYS = ["PI_SCOUT_SKIP_HOST_MCP_SETUP", "OPENSCOUT_SKIP_HOST_MCP_SETUP"];
const SCOUT_BIN_ENV_KEYS = [
  "OPENSCOUT_SCOUT_BIN",
  "SCOUT_BIN",
  "OPENSCOUT_CLI_BIN",
  "SCOUT_CLI_BIN",
];

function printHelp() {
  console.log([
    "Usage: node ./scripts/setup-host-mcp.mjs [--host <codex|claude>] [--force] [--dry-run] [--verbose]",
    "",
    "Best-effort host setup for Scout MCP.",
    "",
    "Examples:",
    "  node ./scripts/setup-host-mcp.mjs",
    "  node ./scripts/setup-host-mcp.mjs --host codex --force",
    "  node ./scripts/setup-host-mcp.mjs --dry-run --verbose",
  ].join("\n"));
}

function isTruthyEnv(value) {
  return typeof value === "string" && TRUTHY_ENV_PATTERN.test(value.trim());
}

function shouldSkipAutoSetup(env) {
  if (SKIP_ENV_KEYS.some((key) => isTruthyEnv(env[key]))) {
    return { skip: true, reason: "disabled by environment" };
  }
  if (isTruthyEnv(env.CI)) {
    return { skip: true, reason: "CI environment detected" };
  }
  return { skip: false, reason: null };
}

function isExecutable(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableFromSearchPath(names, env) {
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const commonDirectories = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/Applications/Codex.app/Contents/Resources",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  for (const directory of [...pathEntries, ...commonDirectories]) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveHostExecutable(host, env) {
  if (host === "codex") {
    return resolveExecutableFromSearchPath(["codex"], env);
  }
  return resolveExecutableFromSearchPath(["claude"], env);
}

function resolveScoutExecutable(env) {
  for (const key of SCOUT_BIN_ENV_KEYS) {
    const candidate = env[key];
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return resolveExecutableFromSearchPath(["scout"], env);
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function commandFailed(result) {
  return Boolean(result.error) || result.status !== 0;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: false,
    hosts: [],
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index] ?? "";
    if (!current) {
      continue;
    }
    if (HELP_FLAGS.has(current)) {
      options.help = true;
      continue;
    }
    if (current === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (current === "--force") {
      options.force = true;
      continue;
    }
    if (current === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (current === "--host") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("missing value for --host");
      }
      options.hosts.push(value);
      index += 1;
      continue;
    }
    if (current.startsWith("--host=")) {
      options.hosts.push(current.slice("--host=".length));
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  const invalidHosts = options.hosts.filter((host) => !SUPPORTED_HOSTS.includes(host));
  if (invalidHosts.length > 0) {
    throw new Error(`unsupported host value(s): ${invalidHosts.join(", ")}`);
  }

  options.hosts = [...new Set(options.hosts)];
  return options;
}

function log(message, options) {
  if (options.verbose) {
    console.log(`[pi-scout] ${message}`);
  }
}

function note(message) {
  console.log(`[pi-scout] ${message}`);
}

function warn(message) {
  console.warn(`[pi-scout] ${message}`);
}

function installWithScoutCli({ scoutExecutable, hosts, dryRun, force, env, options }) {
  const args = [
    "mcp",
    "install",
    ...hosts.flatMap((host) => ["--host", host]),
    ...(force ? ["--force"] : []),
    ...(dryRun ? ["--dry-run"] : []),
  ];
  log(`Trying Scout-managed MCP install: ${formatCommand(scoutExecutable, args)}`, options);
  const result = run(scoutExecutable, args, env);
  if (commandFailed(result)) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || "command failed";
    return {
      ok: false,
      detail,
    };
  }
  const detail = result.stdout.trim() || result.stderr.trim();
  if (detail) {
    log(detail, options);
  }
  return {
    ok: true,
    detail,
  };
}

function installDirectlyForHost({ host, executablePath, scoutExecutable, dryRun, force, env }) {
  const displayName = host === "codex" ? "Codex" : "Claude Code";
  const getArgs = ["mcp", "get", "scout"];
  const removeArgs = host === "codex"
    ? ["mcp", "remove", "scout"]
    : ["mcp", "remove", "--scope", "user", "scout"];
  const addArgs = host === "codex"
    ? ["mcp", "add", "scout", "--", scoutExecutable, "mcp"]
    : ["mcp", "add", "--scope", "user", "scout", "--", scoutExecutable, "mcp"];

  const existing = run(executablePath, getArgs, env);
  if (!commandFailed(existing) && !force) {
    return {
      host,
      status: "already_installed",
      detail: `${displayName} already has a scout MCP entry.`,
    };
  }

  if (dryRun) {
    return {
      host,
      status: "installed",
      detail: `Would run: ${formatCommand(executablePath, addArgs)}`,
    };
  }

  if (!commandFailed(existing) && force) {
    const removed = run(executablePath, removeArgs, env);
    if (commandFailed(removed)) {
      return {
        host,
        status: "failed",
        detail: removed.stderr.trim() || removed.stdout.trim() || `Failed to replace existing ${displayName} MCP config.`,
      };
    }
  }

  const added = run(executablePath, addArgs, env);
  if (commandFailed(added)) {
    return {
      host,
      status: "failed",
      detail: added.stderr.trim() || added.stdout.trim() || `Failed to install scout MCP into ${displayName}.`,
    };
  }

  return {
    host,
    status: "installed",
    detail: `Installed scout MCP for ${displayName}.`,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const skip = shouldSkipAutoSetup(process.env);
  if (skip.skip) {
    log(`Skipping host MCP setup: ${skip.reason}.`, options);
    return;
  }

  const detectedHosts = (options.hosts.length > 0 ? options.hosts : SUPPORTED_HOSTS)
    .map((host) => ({ host, executablePath: resolveHostExecutable(host, process.env) }))
    .filter((entry) => entry.executablePath);

  if (detectedHosts.length === 0) {
    log("No supported host CLIs detected. Looked for codex and claude.", options);
    return;
  }

  const scoutExecutable = resolveScoutExecutable(process.env);
  if (!scoutExecutable) {
    log("No scout executable detected, so host MCP setup was skipped.", options);
    return;
  }

  const preferred = installWithScoutCli({
    scoutExecutable,
    hosts: detectedHosts.map((entry) => entry.host),
    dryRun: options.dryRun,
    force: options.force,
    env: process.env,
    options,
  });
  if (preferred.ok) {
    return;
  }

  log(`Scout CLI install path unavailable, falling back to direct host setup: ${preferred.detail}`, options);

  const outcomes = detectedHosts.map((entry) => installDirectlyForHost({
    host: entry.host,
    executablePath: entry.executablePath,
    scoutExecutable,
    dryRun: options.dryRun,
    force: options.force,
    env: process.env,
  }));

  const failures = outcomes.filter((outcome) => outcome.status === "failed");
  const installed = outcomes.filter((outcome) => outcome.status === "installed");

  if (options.verbose || failures.length > 0 || installed.length > 0) {
    for (const outcome of outcomes) {
      const prefix = outcome.host === "codex" ? "codex" : "claude";
      if (outcome.status !== "already_installed" || options.verbose || failures.length > 0) {
        const logger = outcome.status === "failed" ? warn : note;
        logger(`[${prefix}] ${outcome.detail}`);
      }
    }
  }
}

try {
  main();
} catch (error) {
  warn(error instanceof Error ? error.message : String(error));
  process.exitCode = 0;
}
