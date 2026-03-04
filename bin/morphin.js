#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const https = require('node:https')
const http = require('node:http')

const DEFAULT_REGISTRY = 'https://registry.morphin.dev/registry.json'

function printHelp() {
  console.log(`morphin CLI

Usage:
  morphin list [--registry <url-or-path>]
  morphin add <component...> [--registry <url-or-path>] [--cwd <path>] [--dry-run] [--overwrite] [--install] [--pm <npm|pnpm|yarn|bun>]

Examples:
  morphin list
  morphin add beautiful-layout-page-with-pulse-stripes
  morphin add beautiful-layout-page-with-pulse-stripes --registry ./registry/registry.json --dry-run
`)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }

    if (
      arg === '--registry' ||
      arg === '--cwd' ||
      arg === '--pm'
    ) {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for ${arg}`)
      }
      flags[arg.slice(2)] = value
      i += 1
      continue
    }

    if (arg === '--dry-run' || arg === '--overwrite' || arg === '--install') {
      flags[arg.slice(2)] = true
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  return { positional, flags }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

function stripJsonExtension(value) {
  return value.endsWith('.json') ? value.slice(0, -'.json'.length) : value
}

function fetchText(url) {
  if (typeof fetch === 'function') {
    return fetch(url).then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
      }
      return res.text()
    })
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http
    client
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Failed to fetch ${url}: ${res.statusCode}`))
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve(data))
      })
      .on('error', reject)
  })
}

async function loadRegistry(registryInput, cwd) {
  let source = registryInput || process.env.MORPHIN_REGISTRY
  if (!source) {
    const localDefault = path.resolve(cwd, 'registry/registry.json')
    source = fs.existsSync(localDefault) ? localDefault : DEFAULT_REGISTRY
  }

  if (isHttpUrl(source)) {
    const raw = await fetchText(source)
    const json = JSON.parse(raw)
    return {
      json,
      source,
      kind: 'remote',
      baseUrl: source,
    }
  }

  const absolutePath = path.isAbsolute(source)
    ? source
    : path.resolve(cwd, source)
  const raw = fs.readFileSync(absolutePath, 'utf8')
  const json = JSON.parse(raw)
  return {
    json,
    source: absolutePath,
    kind: 'local',
    baseDir: path.dirname(absolutePath),
  }
}

function getRegistryItems(registryCtx) {
  const items = registryCtx.json?.items || []
  if (!Array.isArray(items)) {
    throw new Error('Invalid registry: "items" must be an array')
  }
  return items
}

function ensureWithinDir(baseDir, candidate) {
  const absoluteBase = path.resolve(baseDir)
  const absoluteCandidate = path.resolve(candidate)
  if (
    absoluteCandidate !== absoluteBase &&
    !absoluteCandidate.startsWith(absoluteBase + path.sep)
  ) {
    throw new Error(`Refusing to write outside target directory: ${absoluteCandidate}`)
  }
  return absoluteCandidate
}

function normalizeRelativePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('Expected a non-empty path string')
  }
  const posixPath = inputPath.replace(/\\/g, '/')
  if (posixPath.startsWith('/')) {
    throw new Error(`Absolute paths are not allowed: ${inputPath}`)
  }
  const normalized = path.posix.normalize(posixPath)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path traversal is not allowed: ${inputPath}`)
  }
  return normalized
}

async function readTextFromRegistryPaths(registryCtx, paths) {
  let lastError = null
  for (const candidate of paths) {
    try {
      if (isHttpUrl(candidate)) {
        return await fetchText(candidate)
      }

      if (registryCtx.kind === 'remote') {
        const url = new URL(candidate, registryCtx.baseUrl).toString()
        return await fetchText(url)
      }

      const normalized = normalizeRelativePath(candidate)
      const abs = ensureWithinDir(
        registryCtx.baseDir,
        path.resolve(registryCtx.baseDir, normalized),
      )
      if (!fs.existsSync(abs)) {
        lastError = new Error(`Not found: ${candidate}`)
        continue
      }
      return fs.readFileSync(abs, 'utf8')
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error(`Unable to resolve registry paths: ${paths.join(', ')}`)
}

async function readJsonFromRegistryPaths(registryCtx, paths) {
  const raw = await readTextFromRegistryPaths(registryCtx, paths)
  return JSON.parse(raw)
}

function buildItemPathCandidates(name, itemRefPath) {
  const candidates = []
  const registerPath = (inputPath) => {
    if (!inputPath) return
    candidates.push(inputPath)
    if (!inputPath.endsWith('.json')) {
      candidates.push(`${inputPath}.json`)
    }
    if (!inputPath.startsWith('items/')) {
      candidates.push(`items/${inputPath}`)
      if (!inputPath.endsWith('.json')) {
        candidates.push(`items/${inputPath}.json`)
      }
    }
  }

  registerPath(itemRefPath)
  registerPath(name)
  registerPath(`items/${name}.json`)

  return Array.from(new Set(candidates))
}

async function loadRegistryItemByName(registryCtx, name) {
  const items = getRegistryItems(registryCtx)
  const pathCandidates = []

  for (const entry of items) {
    if (typeof entry === 'string') {
      const entryName = stripJsonExtension(path.posix.basename(entry))
      if (entry === name || entryName === name) {
        pathCandidates.push(...buildItemPathCandidates(name, entry))
      }
      continue
    }

    if (!entry || typeof entry !== 'object') continue

    if (entry.name === name && Array.isArray(entry.files)) {
      return entry
    }

    if (entry.name === name) {
      pathCandidates.push(
        ...buildItemPathCandidates(
          name,
          entry.path || entry.item || entry.file || entry.source,
        ),
      )
      continue
    }

    const possiblePath = entry.path || entry.item || entry.file || entry.source
    if (typeof possiblePath === 'string') {
      const entryName = stripJsonExtension(path.posix.basename(possiblePath))
      if (entryName === name) {
        pathCandidates.push(...buildItemPathCandidates(name, possiblePath))
      }
    }
  }

  pathCandidates.push(...buildItemPathCandidates(name))

  const uniquePaths = Array.from(new Set(pathCandidates))
  if (!uniquePaths.length) return null

  try {
    return await readJsonFromRegistryPaths(registryCtx, uniquePaths)
  } catch (error) {
    return null
  }
}

function buildFileSourceCandidates(filePath) {
  const candidates = [filePath]
  if (!filePath.startsWith('files/')) {
    candidates.push(`files/${filePath}`)
  }
  return Array.from(new Set(candidates))
}

async function resolveFileContent(registryCtx, sourcePath) {
  const candidates = buildFileSourceCandidates(sourcePath)
  return readTextFromRegistryPaths(registryCtx, candidates)
}

function resolveDestinationRelativePath(targetPath) {
  const normalized = normalizeRelativePath(targetPath)
  if (normalized === 'src' || normalized.startsWith('src/')) {
    return normalized
  }
  return path.posix.join('src', normalized)
}

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function installDeps(cwd, packageManager, deps) {
  if (deps.length === 0) return
  const uniqueDeps = Array.from(new Set(deps))
  let command = packageManager
  let args

  if (packageManager === 'npm') args = ['install', ...uniqueDeps]
  else if (packageManager === 'pnpm') args = ['add', ...uniqueDeps]
  else if (packageManager === 'yarn') args = ['add', ...uniqueDeps]
  else if (packageManager === 'bun') args = ['add', ...uniqueDeps]
  else throw new Error(`Unsupported package manager: ${packageManager}`)

  console.log(`Installing dependencies with ${command}: ${uniqueDeps.join(', ')}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`Dependency installation failed with ${command}`)
  }
}

function listCommand(registryCtx) {
  const items = getRegistryItems(registryCtx)
  if (items.length === 0) {
    console.log('No components found in registry.')
    return
  }

  console.log(`Registry: ${registryCtx.source}`)
  for (const item of items) {
    if (typeof item === 'string') {
      console.log(`- ${stripJsonExtension(path.posix.basename(item))}`)
      continue
    }

    const name = item?.name || stripJsonExtension(path.posix.basename(item?.path || ''))
    const desc = item?.description ? ` - ${item.description}` : ''
    if (name) console.log(`- ${name}${desc}`)
  }
}

async function addCommand(registryCtx, names, options) {
  if (!names.length) {
    throw new Error('No components provided. Example: morphin add morph-dropdown')
  }

  const cwd = options.cwd
  const dependenciesToInstall = []
  const registryDeps = []
  const installedFiles = []
  const missing = []
  const resolvedItems = []

  for (const name of names) {
    const item = await loadRegistryItemByName(registryCtx, name)
    if (!item) {
      missing.push(name)
      continue
    }
    resolvedItems.push({ name, item })
  }

  if (missing.length) {
    throw new Error(`Unknown components: ${missing.join(', ')}`)
  }

  for (const { name, item } of resolvedItems) {
    const files = Array.isArray(item.files) ? item.files : []

    if (!files.length) {
      console.log(`Skipping ${name}: no files.`)
      continue
    }

    console.log(`Adding ${name}...`)
    for (const rawEntry of files) {
      const entry = typeof rawEntry === 'string' ? { path: rawEntry } : rawEntry
      const targetRel = entry.target || entry.path
      const sourcePath = entry.source || entry.path
      if (!targetRel) {
        throw new Error(`Invalid file entry for ${name}: missing target/path`)
      }
      if (!sourcePath) {
        throw new Error(`Invalid file entry for ${name}: missing source/path`)
      }

      const projectRel = resolveDestinationRelativePath(targetRel)
      const destination = ensureWithinDir(cwd, path.resolve(cwd, projectRel))

      const exists = fs.existsSync(destination)
      if (exists && !options.overwrite) {
        console.log(`- skip ${projectRel} (already exists)`)
        continue
      }

      const content = await resolveFileContent(registryCtx, sourcePath)

      if (options.dryRun) {
        console.log(`- write ${projectRel}`)
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.writeFileSync(destination, content, 'utf8')
        console.log(`- wrote ${projectRel}`)
      }

      installedFiles.push(projectRel)
    }

    if (Array.isArray(item.dependencies)) {
      dependenciesToInstall.push(...item.dependencies)
    }
    if (Array.isArray(item.registryDependencies)) {
      registryDeps.push(...item.registryDependencies)
    }
  }

  if (!installedFiles.length) {
    console.log('No files were installed.')
    return
  }

  if (options.install && !options.dryRun) {
    installDeps(cwd, options.pm || detectPackageManager(cwd), dependenciesToInstall)
  } else if (dependenciesToInstall.length) {
    const uniqueDeps = Array.from(new Set(dependenciesToInstall))
    console.log('\nInstall dependencies:')
    const pm = options.pm || detectPackageManager(cwd)
    if (pm === 'npm') console.log(`npm install ${uniqueDeps.join(' ')}`)
    if (pm === 'pnpm') console.log(`pnpm add ${uniqueDeps.join(' ')}`)
    if (pm === 'yarn') console.log(`yarn add ${uniqueDeps.join(' ')}`)
    if (pm === 'bun') console.log(`bun add ${uniqueDeps.join(' ')}`)
  }

  if (registryDeps.length) {
    const uniqueRegistryDeps = Array.from(new Set(registryDeps))
    console.log('\nInstall registry dependencies with:')
    console.log(`npx shadcn add ${uniqueRegistryDeps.join(' ')}`)
  }
}

async function run(argv) {
  try {
    const { positional, flags } = parseArgs(argv)

    if (flags.help || positional.length === 0) {
      printHelp()
      return
    }

    const command = positional[0]
    const commandArgs = positional.slice(1)
    const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
    const registryCtx = await loadRegistry(flags.registry, process.cwd())

    if (command === 'list') {
      listCommand(registryCtx)
      return
    }

    if (command === 'add') {
      await addCommand(registryCtx, commandArgs, {
        cwd,
        dryRun: Boolean(flags['dry-run']),
        overwrite: Boolean(flags.overwrite),
        install: Boolean(flags.install),
        pm: flags.pm,
      })
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
}

module.exports = { run }
