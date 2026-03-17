# Morphin CLI

Install animated React components and full UI sections from the Morphin registry.

Morphin provides production-ready motion components built with:

* React
* Framer Motion
* Tailwind
* shadcn/ui-compatible patterns

---

# Quick Start

Install a component or page bundle directly into your project:

```bash
npx @morphin/cli add beautiful-layout-page-with-pulse-stripes
```

List available components:

```bash
npx @morphin/cli list
```

Authenticate for Pro-only components:

```bash
npx @morphin/cli login
```

This will fetch components from:

```
https://registry.morphin.dev/registry.json
```

---

# Example

Install a full page bundle:

```bash
npx @morphin/cli add beautiful-layout-page-with-pulse-stripes
```

This installs:

```
src/components/
  hero.tsx
  header.tsx
  animated-lines.tsx
  insights-section.tsx
  brand-marquee.tsx

src/components/ui/
  logo.tsx
```

Dependencies will be suggested automatically:

```bash
npm install framer-motion @number-flow/react lucide-react
```

---

# CLI Usage

```bash
npx @morphin/cli list
npx @morphin/cli add <component>
npx @morphin/cli login
npx @morphin/cli logout
npx @morphin/cli whoami
```

Advanced options:

```bash
npx @morphin/cli list [--registry <url-or-path>]

npx @morphin/cli add <component...>
  [--registry <url-or-path>]
  [--cwd <path>]
  [--dry-run]
  [--overwrite]
  [--no-install]
  [--pm <npm|pnpm|yarn|bun>]

npx @morphin/cli login
  [--token <token>]
  [--no-browser]
```

---

# Examples

Preview installation:

```bash
npx @morphin/cli add beautiful-layout-page-with-pulse-stripes --dry-run
```

Install and auto-install dependencies:

```bash
npx @morphin/cli add beautiful-layout-page-with-pulse-stripes --install
```

Use custom registry:

```bash
npx @morphin/cli list --registry ./registry/registry.json
```

Use an existing token without opening a browser:

```bash
npx @morphin/cli login --token <token> --no-browser
```

---

# Registry Source Resolution

When `--registry` is not provided, the CLI resolves the registry source in this order:

1. `MORPHIN_REGISTRY` environment variable
2. Local `./registry/registry.json` (if present)
3. Default registry:

```
https://registry.morphin.dev/registry.json
```

---

# Registry Structure

Example registry layout:

```
registry/
  registry.json
  items/
    beautiful-layout-page-with-pulse-stripes.json
  files/
    components/
      hero.tsx
      header.tsx
      animated-lines.tsx
      insights-section.tsx
      brand-marquee.tsx
      ui/
        logo.tsx
```

Each item manifest describes:

* files to install
* dependencies
* optional registry dependencies

---

# Notes

* Installed files are written under `src/` by default.
* Existing files are skipped unless `--overwrite` is used.
* `--dry-run` previews file writes without modifying the filesystem.
* CLI tokens are stored in `~/.morphin/config.json`.
* `MORPHIN_TOKEN` can be used to authenticate without writing a local config file.
* Remote registry requests automatically include `Authorization: Bearer <token>` when a token is available.
* Pro-only components return an upgrade prompt that links to `https://morphin.dev/pricing`.
* `registryDependencies` are printed as:

```
npx shadcn add ...
```

and are **not auto-installed**.

---

# Links

Registry
https://registry.morphin.dev

Website
https://morphin.dev
