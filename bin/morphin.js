#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const https = require("node:https");
const http = require("node:http");

const FREE_REGISTRY =
  "https://raw.githubusercontent.com/sikkeep/morphin-registry/main/registry.json";
const PRO_REGISTRY =
  "https://cdn.morphin.dev/camellia/components/pro/registry.json";
const DEFAULT_REGISTRY = FREE_REGISTRY;
const DEFAULT_SITE_URL = "https://morphin.dev";
const CONFIG_DIR = ".morphin";
const CONFIG_FILE = "config.json";

function printHelp() {
  console.log(`morphin CLI

Usage:
  npx @morphin/cli list [--registry <url-or-path>]
  npx @morphin/cli add <component...> [--registry <url-or-path>] [--cwd <path>] [--dry-run] [--overwrite] [--no-install] [--pm <npm|pnpm|yarn|bun>]
  npx @morphin/cli login [--token <token>]
  npx @morphin/cli logout
  npx @morphin/cli whoami

Examples:
  npx @morphin/cli list
  npx @morphin/cli add beautiful-layout-page-with-pulse-stripes
  npx @morphin/cli add beautiful-layout-page-with-pulse-stripes --registry ./registry/registry.json --dry-run
  npx @morphin/cli login
  npx @morphin/cli login --token <token> --no-browser
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }

    if (
      arg === "--registry" ||
      arg === "--cwd" ||
      arg === "--pm" ||
      arg === "--token"
    ) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      flags[arg.slice(2)] = value;
      i += 1;
      continue;
    }

    if (
      arg === "--dry-run" ||
      arg === "--overwrite" ||
      arg === "--no-install"
    ) {
      flags[arg.slice(2)] = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { positional, flags };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function stripJsonExtension(value) {
  return value.endsWith(".json") ? value.slice(0, -".json".length) : value;
}

function getConfigPath() {
  return path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE);
}

function getSiteUrl() {
  return process.env.MORPHIN_SITE_URL || DEFAULT_SITE_URL;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Morphin config at ${configPath}`);
  }

  return parsed;
}

function ensureConfigDir() {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function getStoredToken() {
  const config = readConfig();
  return typeof config.token === "string" && config.token.trim()
    ? config.token.trim()
    : null;
}

function getTokenInfo() {
  const envToken = process.env.MORPHIN_TOKEN;
  if (typeof envToken === "string" && envToken.trim()) {
    return {
      token: envToken.trim(),
      source: "environment variable MORPHIN_TOKEN",
    };
  }

  const storedToken = getStoredToken();
  if (!storedToken) {
    return null;
  }

  return {
    token: storedToken,
    source: getConfigPath(),
  };
}

function saveToken(token) {
  writeConfig({ token });
}

function clearStoredToken() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return false;
  }

  fs.unlinkSync(configPath);
  return true;
}

function buildAuthHeaders(tokenInfo = getTokenInfo()) {
  if (!tokenInfo?.token) {
    return {};
  }

  return {
    Authorization: `Bearer ${tokenInfo.token}`,
  };
}

function maskToken(token) {
  if (token.length <= 8) {
    return token;
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function requestText(url, options = {}) {
  if (typeof fetch === "function") {
    return fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
    }).then(async (res) => ({
      status: res.status,
      statusText: res.statusText,
      text: await res.text(),
    }));
  }

  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const client = targetUrl.protocol === "https:" ? https : http;
    const req = client.request(
      targetUrl,
      {
        method: options.method || "GET",
        headers: options.headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            text: data,
          });
        });
      },
    );

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

function createHttpError(url, response) {
  const parsedBody = safeJsonParse(response.text);
  const message =
    parsedBody?.message ||
    parsedBody?.error ||
    `Failed to fetch ${url}: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  const error = new Error(message);
  error.name = "MorphinHttpError";
  error.url = url;
  error.status = response.status;
  error.statusText = response.statusText;
  error.body = response.text;
  error.code = parsedBody?.code || parsedBody?.error || null;
  return error;
}

async function fetchText(url, options = {}) {
  const response = await requestText(url, options);
  if (response.status >= 400) {
    throw createHttpError(url, response);
  }
  return response.text;
}

function isProRequiredError(error) {
  if (!error || error.status !== 403) {
    return false;
  }

  const combined =
    `${error.code || ""} ${error.message || ""} ${error.body || ""}`.toUpperCase();
  return combined.includes("PRO_REQUIRED");
}

function isUnauthorizedError(error) {
  if (!error) {
    return false;
  }

  if (error.status === 401) {
    return true;
  }

  if (error.status !== 403) {
    return false;
  }

  const combined =
    `${error.code || ""} ${error.message || ""} ${error.body || ""}`.toUpperCase();
  return (
    combined.includes("AUTH_REQUIRED") || combined.includes("UNAUTHORIZED")
  );
}

function printProRequiredMessage() {
  console.error("This component requires Morphin Pro.");
  console.error("");
  console.error("Upgrade here:");
  console.error(new URL("/pricing", getSiteUrl()).toString());
}

function printAuthenticationRequiredMessage() {
  console.error("Authentication required. Run `morphin login` and try again.");
}

async function loadRegistry(registryInput, cwd, requestOptions = {}) {
  let source = registryInput || process.env.MORPHIN_REGISTRY;
  if (!source) {
    const localDefault = path.resolve(cwd, "registry/registry.json");
    source = fs.existsSync(localDefault) ? localDefault : DEFAULT_REGISTRY;
  }

  if (isHttpUrl(source)) {
    const raw = await fetchText(source, requestOptions);
    const json = JSON.parse(raw);
    return {
      json,
      source,
      kind: "remote",
      baseUrl: source,
      requestOptions,
    };
  }

  const absolutePath = path.isAbsolute(source)
    ? source
    : path.resolve(cwd, source);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const json = JSON.parse(raw);
  return {
    json,
    source: absolutePath,
    kind: "local",
    baseDir: path.dirname(absolutePath),
    requestOptions,
  };
}

function getRegistryItems(registryCtx) {
  const items = registryCtx.json?.items || [];
  if (!Array.isArray(items)) {
    throw new Error('Invalid registry: "items" must be an array');
  }
  return items;
}

function ensureWithinDir(baseDir, candidate) {
  const absoluteBase = path.resolve(baseDir);
  const absoluteCandidate = path.resolve(candidate);
  if (
    absoluteCandidate !== absoluteBase &&
    !absoluteCandidate.startsWith(absoluteBase + path.sep)
  ) {
    throw new Error(
      `Refusing to write outside target directory: ${absoluteCandidate}`,
    );
  }
  return absoluteCandidate;
}

function normalizeRelativePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("Expected a non-empty path string");
  }
  const posixPath = inputPath.replace(/\\/g, "/");
  if (posixPath.startsWith("/")) {
    throw new Error(`Absolute paths are not allowed: ${inputPath}`);
  }
  const normalized = path.posix.normalize(posixPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Path traversal is not allowed: ${inputPath}`);
  }
  return normalized;
}

async function readTextFromRegistryPaths(registryCtx, paths) {
  let lastError = null;
  for (const candidate of paths) {
    try {
      if (isHttpUrl(candidate)) {
        return await fetchText(candidate, registryCtx.requestOptions);
      }

      if (registryCtx.kind === "remote") {
        const url = new URL(candidate, registryCtx.baseUrl).toString();
        return await fetchText(url, registryCtx.requestOptions);
      }

      const normalized = normalizeRelativePath(candidate);
      const abs = ensureWithinDir(
        registryCtx.baseDir,
        path.resolve(registryCtx.baseDir, normalized),
      );
      if (!fs.existsSync(abs)) {
        lastError = new Error(`Not found: ${candidate}`);
        continue;
      }
      return fs.readFileSync(abs, "utf8");
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(`Unable to resolve registry paths: ${paths.join(", ")}`)
  );
}

async function readJsonFromRegistryPaths(registryCtx, paths) {
  const raw = await readTextFromRegistryPaths(registryCtx, paths);
  return JSON.parse(raw);
}

function buildItemPathCandidates(name, itemRefPath) {
  const candidates = [];
  const registerPath = (inputPath) => {
    if (!inputPath) return;
    candidates.push(inputPath);
    if (!inputPath.endsWith(".json")) {
      candidates.push(`${inputPath}.json`);
    }
    if (!inputPath.startsWith("items/")) {
      candidates.push(`items/${inputPath}`);
      if (!inputPath.endsWith(".json")) {
        candidates.push(`items/${inputPath}.json`);
      }
    }
  };

  registerPath(itemRefPath);
  registerPath(name);
  registerPath(`items/${name}.json`);

  return Array.from(new Set(candidates));
}

async function loadRegistryItemByName(registryCtx, name) {
  const items = getRegistryItems(registryCtx);
  const pathCandidates = [];

  for (const entry of items) {
    if (typeof entry === "string") {
      const entryName = stripJsonExtension(path.posix.basename(entry));
      if (entry === name || entryName === name) {
        pathCandidates.push(...buildItemPathCandidates(name, entry));
      }
      continue;
    }

    if (!entry || typeof entry !== "object") continue;

    if (entry.name === name && Array.isArray(entry.files)) {
      return entry;
    }

    if (entry.name === name) {
      pathCandidates.push(
        ...buildItemPathCandidates(
          name,
          entry.path || entry.item || entry.file || entry.source,
        ),
      );
      continue;
    }

    const possiblePath = entry.path || entry.item || entry.file || entry.source;
    if (typeof possiblePath === "string") {
      const entryName = stripJsonExtension(path.posix.basename(possiblePath));
      if (entryName === name) {
        pathCandidates.push(...buildItemPathCandidates(name, possiblePath));
      }
    }
  }

  pathCandidates.push(...buildItemPathCandidates(name));

  const uniquePaths = Array.from(new Set(pathCandidates));
  if (!uniquePaths.length) return null;

  try {
    return await readJsonFromRegistryPaths(registryCtx, uniquePaths);
  } catch {
    return null;
  }
}

function buildFileSourceCandidates(filePath) {
  const candidates = [filePath];
  if (!filePath.startsWith("files/")) {
    candidates.push(`files/${filePath}`);
  }
  return Array.from(new Set(candidates));
}

async function resolveFileContent(registryCtx, sourcePath) {
  const candidates = buildFileSourceCandidates(sourcePath);
  return readTextFromRegistryPaths(registryCtx, candidates);
}

function resolveDestinationRelativePath(targetPath) {
  return normalizeRelativePath(targetPath);
}

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function installDeps(cwd, packageManager, deps) {
  if (deps.length === 0) return;
  const uniqueDeps = Array.from(new Set(deps));
  let command = packageManager;
  let args;

  if (packageManager === "npm") args = ["install", ...uniqueDeps];
  else if (packageManager === "pnpm") args = ["add", ...uniqueDeps];
  else if (packageManager === "yarn") args = ["add", ...uniqueDeps];
  else if (packageManager === "bun") args = ["add", ...uniqueDeps];
  else throw new Error(`Unsupported package manager: ${packageManager}`);

  console.log(
    `Installing dependencies with ${command}: ${uniqueDeps.join(", ")}`,
  );
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`Dependency installation failed with ${command}`);
  }
}

function listCommand(registryCtx) {
  const items = getRegistryItems(registryCtx);
  if (items.length === 0) {
    console.log("No components found in registry.");
    return;
  }

  console.log(`Registry: ${registryCtx.source}`);
  for (const item of items) {
    if (typeof item === "string") {
      console.log(`- ${stripJsonExtension(path.posix.basename(item))}`);
      continue;
    }

    const name =
      item?.name || stripJsonExtension(path.posix.basename(item?.path || ""));
    const desc = item?.description ? ` - ${item.description}` : "";
    if (name) console.log(`- ${name}${desc}`);
  }
}

async function addCommand(registryCtx, names, options) {
  if (!names.length) {
    throw new Error(
      "No components provided. Example: morphin add morph-dropdown",
    );
  }

  const cwd = options.cwd;
  const dependenciesToInstall = [];
  const registryDeps = [];
  const installedFiles = [];
  const missing = [];
  const resolvedItems = [];

  for (const name of names) {
    const item = await loadRegistryItemByName(registryCtx, name);
    if (!item) {
      missing.push(name);
      continue;
    }
    resolvedItems.push({ name, item });
  }

  if (missing.length) {
    throw new Error(`Unknown components: ${missing.join(", ")}`);
  }

  for (const { name, item } of resolvedItems) {
    const files = Array.isArray(item.files) ? item.files : [];

    if (!files.length) {
      console.log(`Skipping ${name}: no files.`);
      continue;
    }

    console.log(`Adding ${name}...`);
    for (const rawEntry of files) {
      const entry =
        typeof rawEntry === "string" ? { path: rawEntry } : rawEntry;
      const targetRel = entry.target || entry.path;
      const sourcePath = entry.source || entry.path;
      if (!targetRel) {
        throw new Error(`Invalid file entry for ${name}: missing target/path`);
      }
      if (!sourcePath) {
        throw new Error(`Invalid file entry for ${name}: missing source/path`);
      }

      const projectRel = resolveDestinationRelativePath(targetRel);
      const destination = ensureWithinDir(cwd, path.resolve(cwd, projectRel));

      const exists = fs.existsSync(destination);
      if (exists && !options.overwrite) {
        console.log(`- skip ${projectRel} (already exists)`);
        continue;
      }

      const content = await resolveFileContent(registryCtx, sourcePath);

      if (options.dryRun) {
        console.log(`- write ${projectRel}`);
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content, "utf8");
        console.log(`- wrote ${projectRel}`);
      }

      installedFiles.push(projectRel);
    }

    if (Array.isArray(item.dependencies)) {
      dependenciesToInstall.push(...item.dependencies);
    }
    if (Array.isArray(item.registryDependencies)) {
      registryDeps.push(...item.registryDependencies);
    }
  }

  if (!installedFiles.length) {
    console.log("No files were installed.");
    return;
  }

  if (options.install && !options.dryRun) {
    installDeps(
      cwd,
      options.pm || detectPackageManager(cwd),
      dependenciesToInstall,
    );
  } else if (dependenciesToInstall.length) {
    const uniqueDeps = Array.from(new Set(dependenciesToInstall));
    console.log("\nInstall dependencies:");
    const pm = options.pm || detectPackageManager(cwd);
    if (pm === "npm") console.log(`npm install ${uniqueDeps.join(" ")}`);
    if (pm === "pnpm") console.log(`pnpm add ${uniqueDeps.join(" ")}`);
    if (pm === "yarn") console.log(`yarn add ${uniqueDeps.join(" ")}`);
    if (pm === "bun") console.log(`bun add ${uniqueDeps.join(" ")}`);
  }

  if (registryDeps.length) {
    const uniqueRegistryDeps = Array.from(new Set(registryDeps));
    console.log("\nInstall registry dependencies with:");
    console.log(`npx shadcn add ${uniqueRegistryDeps.join(" ")}`);
  }
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const result = spawnSync(command, args, {
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  return result.status === 0 && !result.error;
}


async function loginCommand(options = {}) {
  const siteUrl = getSiteUrl();
  let token = options.token;

  if (!token) {
    let sessionRes;
    try {
      sessionRes = await fetchText(`${siteUrl}/api/cli/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      throw new Error(
        `Could not reach ${siteUrl} to start login: ${err.message}`,
      );
    }

    const { sessionId, url } = JSON.parse(sessionRes);

    console.log("Opening browser for authentication...");
    if (!openBrowser(url)) {
      console.log(`Open this URL to authenticate: ${url}`);
    }

    console.log("Waiting for authentication...");

    const TIMEOUT_MS = 2 * 60 * 1000;
    const POLL_INTERVAL_MS = 2000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let pollRes;
      try {
        pollRes = await requestText(
          `${siteUrl}/api/cli/session/${sessionId}`,
        );
      } catch {
        continue;
      }

      if (pollRes.status === 404 || pollRes.status === 410) {
        throw new Error("Login session expired. Run `morphin login` again.");
      }

      const data = safeJsonParse(pollRes.text);
      if (data?.status === "done" && data?.token) {
        token = data.token;
        break;
      }
    }

    if (!token) {
      throw new Error("Authentication timed out. Run `morphin login` again.");
    }
  }

  if (!token || !token.trim()) {
    throw new Error("No token provided");
  }

  saveToken(token.trim());
  console.log("✔ Login successful");
  console.log(`✔ Token saved to ${getConfigPath()}`);
}

function logoutCommand() {
  const removed = clearStoredToken();

  if (removed) {
    console.log("✔ Logged out");
  } else {
    console.log("No stored token found.");
  }

  if (process.env.MORPHIN_TOKEN) {
    console.log(
      "MORPHIN_TOKEN is still set in this shell and will continue to be used.",
    );
  }
}

async function resolveWhoAmI(tokenInfo) {
  const url = new URL("/api/cli/whoami", getSiteUrl()).toString();
  let response;

  try {
    response = await requestText(url, {
      headers: buildAuthHeaders(tokenInfo),
    });
  } catch {
    return null;
  }

  if (response.status === 404 || response.status === 405) {
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    return { invalid: true };
  }

  if (response.status >= 400) {
    return null;
  }

  const payload = safeJsonParse(response.text);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return payload;
}

async function whoamiCommand() {
  const tokenInfo = getTokenInfo();
  if (!tokenInfo) {
    console.log("Not logged in.");
    return;
  }

  const profile = await resolveWhoAmI(tokenInfo);
  if (profile?.invalid) {
    console.log(
      "Stored token appears invalid or expired. Run `morphin login` again.",
    );
    return;
  }

  console.log(`Authenticated via ${tokenInfo.source}`);
  if (profile?.email) {
    console.log(`Email: ${profile.email}`);
  }
  if (profile?.name) {
    console.log(`Name: ${profile.name}`);
  }
  if (profile?.plan) {
    console.log(`Plan: ${profile.plan}`);
  }
  console.log(`Token: ${maskToken(tokenInfo.token)}`);
}

// Resolves which registry to use when no explicit --registry flag is given.
// PRO users (logged in + active subscription) get the CDN registry.
// Everyone else gets the free GitHub registry.
async function resolveDefaultRegistry(flags) {
  if (flags.registry) return flags.registry;
  if (process.env.MORPHIN_REGISTRY) return process.env.MORPHIN_REGISTRY;

  const tokenInfo = getTokenInfo();
  if (!tokenInfo) return FREE_REGISTRY;

  const profile = await resolveWhoAmI(tokenInfo);
  if (profile?.isPro) return PRO_REGISTRY;

  return FREE_REGISTRY;
}

async function run(argv) {
  try {
    const { positional, flags } = parseArgs(argv);

    if (flags.help || positional.length === 0) {
      printHelp();
      return;
    }

    const command = positional[0];
    const commandArgs = positional.slice(1);
    const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();

    if (command === "login") {
      await loginCommand({ token: flags.token });
      return;
    }

    if (command === "logout") {
      logoutCommand();
      return;
    }

    if (command === "whoami") {
      await whoamiCommand();
      return;
    }

    const resolvedRegistry = await resolveDefaultRegistry(flags);
    const registryCtx = await loadRegistry(resolvedRegistry, process.cwd(), {
      headers: buildAuthHeaders(),
    });

    if (command === "list") {
      listCommand(registryCtx);
      return;
    }

    if (command === "add") {
      await addCommand(registryCtx, commandArgs, {
        cwd,
        dryRun: Boolean(flags["dry-run"]),
        overwrite: Boolean(flags.overwrite),
        install: !flags["no-install"],
        pm: flags.pm,
      });
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (isProRequiredError(error)) {
      printProRequiredMessage();
      process.exitCode = 1;
      return;
    }

    if (isUnauthorizedError(error)) {
      printAuthenticationRequiredMessage();
      process.exitCode = 1;
      return;
    }

    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2));
}

module.exports = {
  run,
  parseArgs,
  getConfigPath,
  getTokenInfo,
  isProRequiredError,
  isUnauthorizedError,
};
