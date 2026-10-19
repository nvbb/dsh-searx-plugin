#!/usr/bin/env node
/**
 * `npx` installer/status CLI for the SearXNG search provider.
 *
 * This file intentionally imports only Node built-ins and the dependency-free
 * URL helpers, so `npx github:nvbb/dsh-searx-plugin setup` works before the
 * plugin is mounted into a DSH profile.
 *
 * @module dsh-web-search-searxng/cli
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSearchURL, normalizeBaseURL } from "../lib/url.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const PROVIDER_ID = "searxng";
const PROVIDER_ENTRY = "web-search-searxng";
const WEB_ENTRY = "web";

const USAGE = `${pkg.name} ${pkg.version}

Usage:
  npx github:nvbb/dsh-searx-plugin setup --url <url> [options]
  npx github:nvbb/dsh-searx-plugin status [options]
  npx github:nvbb/dsh-searx-plugin check --url <url> [options]

Commands:
  setup     Validate the SearXNG endpoint, install the plugin into a profile,
            and point web.searchProvider at "searxng".
  status    Show the configured provider and base URL (read-only).
  check     Fetch /search?format=json from a URL and report whether it works.
  help      Show this help.

Options:
  --url <url>             SearXNG base URL (setup/check).
  --profile <name>        DSH profile name. Default: web.
  --language <code>       SearXNG language, e.g. zh-CN.
  --engines <list>        Comma-separated engine allowlist.
  --categories <list>     Comma-separated categories.
  --plugin <spec>         Override the package spec passed to \`dsh plugin add\`.
  --skip-install          Only patch the profile; do not run dsh plugin add.
  --no-check              Skip the HTTP JSON check.
  --profile-file <path>   Override cordis.patch.yml (tests/advanced).
  --dsh <path>            dsh executable. Default: dsh.
  -h, --help              Show this help.

Examples:
  npx github:nvbb/dsh-searx-plugin setup --url https://search.example.com/searxng
  npx github:nvbb/dsh-searx-plugin status --check
  npx github:nvbb/dsh-searx-plugin setup --url http://127.0.0.1:8080 --profile research
`;

class CliError extends Error {}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new CliError(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--url") options.url = value();
    else if (arg === "--profile") options.profile = value();
    else if (arg === "--language") options.language = value();
    else if (arg === "--engines") options.engines = value();
    else if (arg === "--categories") options.categories = value();
    else if (arg === "--plugin") options.plugin = value();
    else if (arg === "--profile-file") options.profileFile = value();
    else if (arg === "--dsh") options.dsh = value();
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--no-check") options.noCheck = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new CliError(`Unknown option ${arg}`);
    else options._.push(arg);
  }
  return options;
}

function profileName(options) {
  return options.profile ?? "web";
}

function profileFile(options) {
  if (options.profileFile !== undefined) return path.resolve(options.profileFile);
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", profileName(options), "cordis.patch.yml");
}

function quoteYaml(value) {
  if (/[\r\n]/u.test(value)) throw new CliError("YAML scalar values must not contain newlines");
  return "'" + value.replace(/'/gu, "''") + "'";
}

function unquoteYaml(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/gu, '"');
  }
  return trimmed;
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u);
}

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function findBlock(lines, id) {
  const pattern = new RegExp("^- id:\\s*['\"]?" + id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "['\"]?\\s*$", "u");
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      let end = lines.length;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^- /u.test(lines[next])) {
          end = next;
          break;
        }
      }
      return { start: index, end };
    }
  }
  return undefined;
}

function setConfigValue(lines, block, key, value) {
  const keyPattern = new RegExp("^(\\s+)" + key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + ":\\s*(.*)$", "u");
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = keyPattern.exec(lines[index]);
    if (match !== null) {
      lines[index] = match[1] + key + ": " + value;
      return;
    }
  }
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = /^(\s+)config:\s*$/u.exec(lines[index]);
    if (match !== null) {
      lines.splice(index + 1, 0, match[1] + "  " + key + ": " + value);
      block.end += 1;
      return;
    }
  }
  const insertAt = block.end > block.start + 1 && lines[block.end - 1].trim().length === 0
    ? block.end - 1
    : block.end;
  lines.splice(insertAt, 0, "  config:", "    " + key + ": " + value);
  block.end += 2;
}

function addBlock(lines, id, config) {
  if (lines.length > 0 && lines[lines.length - 1].trim().length !== 0) lines.push("");
  lines.push("- id: " + id, "  config:");
  for (const [key, value] of Object.entries(config)) lines.push("    " + key + ": " + value);
  return { start: lines.length - Object.keys(config).length - 2, end: lines.length };
}

function getConfigValue(lines, id, key) {
  const block = findBlock(lines, id);
  if (block === undefined) return undefined;
  const pattern = new RegExp("^\\s+" + key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + ":\\s*(.*)$", "u");
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) return unquoteYaml(match[1]);
  }
  return undefined;
}

function readPatch(file) {
  if (!fs.existsSync(file)) {
    throw new CliError(`Profile patch not found: ${file}\nStart 'dsh --profile ${profileName({})}' once to initialize it, or pass --profile-file.`);
  }
  return readLines(file);
}

function backupPatch(file) {
  const stamp = new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  const backup = `${file}.bak-${stamp}-searxcli`;
  fs.copyFileSync(file, backup);
  return backup;
}

function patchProfile(options, baseURL) {
  const file = profileFile(options);
  const lines = readPatch(file);
  const backup = backupPatch(file);

  let web = findBlock(lines, WEB_ENTRY);
  if (web === undefined) {
    web = addBlock(lines, WEB_ENTRY, { searchProvider: PROVIDER_ID });
  } else {
    setConfigValue(lines, web, "searchProvider", PROVIDER_ID);
  }

  const config = { baseURL: quoteYaml(baseURL.href) };
  if (options.language !== undefined && options.language.length > 0) config.language = quoteYaml(options.language);
  if (options.engines !== undefined && options.engines.length > 0) config.engines = quoteYaml(options.engines);
  if (options.categories !== undefined && options.categories.length > 0) config.categories = quoteYaml(options.categories);

  const provider = findBlock(lines, PROVIDER_ENTRY);
  if (provider === undefined) {
    addBlock(lines, PROVIDER_ENTRY, config);
  } else {
    for (const [key, value] of Object.entries(config)) setConfigValue(lines, provider, key, value);
  }

  writeLines(file, lines);
  return { file, backup };
}

function defaultPluginSpec() {
  const explicit = process.env.DSH_SEARX_PLUGIN_SPEC;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const normalized = packageRoot.replace(/\\/gu, "/");
  const fromPackageCache = /\/_npx\/|\/node_modules\//u.test(normalized);
  if (!fromPackageCache) return "file:" + normalized;
  const repository = typeof pkg.repository?.url === "string" ? pkg.repository.url : "";
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/u.exec(repository);
  if (match !== null) return `github:${match[1]}/${match[2]}`;
  return "file:" + normalized;
}

function installPlugin(options) {
  const spec = options.plugin ?? defaultPluginSpec();
  const dsh = options.dsh ?? "dsh";
  const args = ["plugin", "--profile", profileName(options), "add", spec];
  console.log(`[searx] ${dsh} ${args.join(" ")}`);
  const quote = (value) => '"' + String(value).replace(/"/gu, '""') + '"';
  const executable = /\s/u.test(dsh) ? quote(dsh) : dsh;
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [executable, ...args.map(quote)].join(" ")], {
      stdio: "inherit",
      cwd: process.cwd(),
    })
    : spawnSync(dsh, args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  if (result.error !== undefined && result.error !== null) {
    throw new CliError(`Could not run ${dsh}: ${result.error.message}. Stop 'dsh web' first and make sure dsh is on PATH.`);
  }
  if (result.status !== 0) {
    throw new CliError(`dsh plugin add failed with exit ${String(result.status)}. Stop 'dsh web' and retry.`);
  }
}

async function checkEndpoint(baseURL, options) {
  const request = buildSearchURL(baseURL, { query: "searxng", page: 1 });
  let response;
  try {
    response = await fetch(request, {
      signal: AbortSignal.timeout(12000),
      headers: {
        accept: "application/json",
        "user-agent": `${pkg.name}/${pkg.version}`,
      },
    });
  } catch (error) {
    throw new CliError(`SearXNG request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(`SearXNG returned HTTP ${response.status}. Enable JSON output in settings.yml (search.formats must include json).`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CliError("SearXNG returned a non-JSON response. Enable JSON output in settings.yml (search.formats must include json).");
  }
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
    throw new CliError("SearXNG returned JSON without a results array.");
  }
  console.log(`[searx] JSON OK: ${payload.results.length} result(s) from ${baseURL.href}`);
}

async function commandSetup(options) {
  const rawURL = options.url ?? options._[1];
  if (rawURL === undefined || rawURL.length === 0) {
    throw new CliError("Missing --url. Usage: setup --url https://search.example.com/searxng");
  }
  const baseURL = normalizeBaseURL(rawURL);
  if (baseURL === undefined) {
    throw new CliError("Invalid URL. Use an absolute http(s) URL without credentials, query, or fragment.");
  }
  if (options.noCheck !== true) await checkEndpoint(baseURL, options);
  if (options.skipInstall !== true) installPlugin(options);
  const { file, backup } = patchProfile(options, baseURL);
  console.log(`[searx] patched ${file}`);
  console.log(`[searx] backup: ${backup}`);
  console.log("[searx] restart dsh web, then use web_search or /searxng status");
}

async function commandStatus(options) {
  const file = profileFile(options);
  const lines = readPatch(file);
  const provider = getConfigValue(lines, WEB_ENTRY, "searchProvider") ?? "(unset)";
  const baseURL = getConfigValue(lines, PROVIDER_ENTRY, "baseURL") ?? "(unset)";
  console.log(`[searx] profile: ${file}`);
  console.log(`[searx] provider: ${provider}`);
  console.log(`[searx] baseURL: ${baseURL}`);
  if (options.check === true && baseURL !== "(unset)") {
    const normalized = normalizeBaseURL(baseURL);
    if (normalized === undefined) throw new CliError(`Configured baseURL is invalid: ${baseURL}`);
    await checkEndpoint(normalized, options);
  }
}

async function commandCheck(options) {
  const rawURL = options.url ?? options._[1];
  if (rawURL === undefined || rawURL.length === 0) {
    throw new CliError("Missing --url. Usage: check --url https://search.example.com/searxng");
  }
  const baseURL = normalizeBaseURL(rawURL);
  if (baseURL === undefined) {
    throw new CliError("Invalid URL. Use an absolute http(s) URL without credentials, query, or fragment.");
  }
  await checkEndpoint(baseURL, options);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? (options.help ? "help" : "setup");
  if (options.help === true || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "setup") return commandSetup(options);
  if (command === "status") return commandStatus(options);
  if (command === "check") return commandCheck(options);
  throw new CliError(`Unknown command "${command}". Run with --help.`);
}

main().catch((error) => {
  const message = error instanceof CliError ? error.message : (error instanceof Error ? error.message : String(error));
  console.error(`[searx] ERROR: ${message}`);
  process.exitCode = 1;
});
