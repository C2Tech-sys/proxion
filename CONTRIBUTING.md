# Contributing to Proxion

Thanks for taking a look at Proxion. It's early (pre-1.0) and there's
plenty of room to help.

## Dev setup

Requirements: Node >= 24, pnpm (the workspace pins an exact version via
`packageManager` in `package.json` -- run `corepack enable` and pnpm will
use it automatically).

```bash
git clone https://github.com/C2Tech-sys/proxion.git
cd proxion
pnpm install
pnpm dev
```

- Web app: http://localhost:5173 (Vite dev server; `/api` and `/ws` are proxied to the server)
- Server API: http://localhost:3080 (health check at `/api/health`)

No Proxmox host handy? Run the web app against static fixtures instead:

```bash
VITE_USE_FIXTURES=1 pnpm --filter @proxion/web dev
```

### Working from a Dropbox-synced folder

If your checkout lives inside a Dropbox-synced folder, each workspace's
`node_modules` is large, churns constantly, and should never be synced.
After `pnpm install`, run `scripts/dropbox-ignore.ps1` (PowerShell) to mark
every `node_modules` directory as Dropbox-ignored (via the
`com.dropbox.ignored` alternate data stream), and re-run it whenever a new
`node_modules` appears. A normal clone outside Dropbox needs none of this.

### Workspace layout

- `apps/web` -- `@proxion/web`, the React UI (Vite, Tailwind v4, shadcn/ui, TanStack Router/Query).
- `apps/server` -- `@proxion/server`, the Fastify API/proxy server.
- `packages/pve-api` -- `@proxion/pve-api`, the generated Proxmox VE API client.

## pnpm scripts

Run from the repo root (each fans out to every workspace package via `pnpm -r`, except `lint`):

| Script           | What it does                                  |
| ---------------- | --------------------------------------------- |
| `pnpm dev`       | Runs the web and server dev servers together. |
| `pnpm build`     | Builds every package.                         |
| `pnpm typecheck` | Type-checks every package (`tsc --noEmit`).   |
| `pnpm lint`      | `eslint .` across the whole repo.             |
| `pnpm test`      | Runs every package's test suite (Vitest).     |
| `pnpm format`    | `prettier --write .`                          |

CI runs `pnpm build`, `pnpm typecheck`, `pnpm exec eslint . --max-warnings 0`,
`pnpm test`, and a Docker image build on every push and pull request -- run
the same commands locally before opening a PR.

## GitHub Pages demo

`.github/workflows/pages.yml` builds `@proxion/web` in fixture mode
(`VITE_USE_FIXTURES=1`, no backend) with `VITE_BASE_PATH` set to the repo's
Pages base path and deploys it to https://c2tech-sys.github.io/proxion/ on
every push to `main` (also runnable manually via `workflow_dispatch`). The
built `index.html` is copied to `404.html` so GitHub Pages' static
404 fallback hands deep links (e.g. `/proxion/vm/pve1/qemu/100`) back to the
SPA, which then resolves the route client-side via the router's
`basepath`.

To reproduce the demo build locally:

```bash
VITE_BASE_PATH=/proxion/ VITE_USE_FIXTURES=1 pnpm --filter @proxion/web build
pnpm --filter @proxion/web exec vite preview --base /proxion/
```

Icon/manifest links in `apps/web/index.html` use Vite's `%BASE_URL%`
placeholder rather than a hard-coded leading slash so they resolve under
that base too; `apps/web/public/site.webmanifest`'s own icon paths are
plain relative paths for the same reason (a web app manifest resolves them
against its own URL, so this works unchanged at the domain root too).

## Branch / PR flow

1. Fork the repo (or branch directly if you have write access) and create a
   feature branch off `main`.
2. Make your change, with tests. Small, focused PRs are easier to review
   than large ones.
3. Make sure `pnpm build`, `pnpm typecheck`, `pnpm exec eslint . --max-warnings 0`,
   and `pnpm test` all pass locally.
4. Open a PR against `main` using the PR template. Link the issue it
   addresses, if any.
5. A maintainer reviews, and CI must be green before merge.

## Releasing

There's no `pnpm version` script -- bump versions by hand:

1. Set the same `"version"` in **every** workspace `package.json` (root,
   `apps/web`, `apps/server`, `packages/pve-api`).
2. Update `CHANGELOG.md`: turn `## [Unreleased]` into `## [X.Y.Z] -
   <YYYY-MM-DD>` with a short intro line, add a fresh empty `## [Unreleased]`
   above it, and update the compare links at the bottom (`[Unreleased]` and
   `[X.Y.Z]`).
3. Commit, then tag `vX.Y.Z` and push the tag. Pushing a `v*` tag runs
   [`.github/workflows/release.yml`](.github/workflows/release.yml), which
   builds and pushes the multi-arch container image to
   `ghcr.io/c2tech-sys/proxion` (tagged `X.Y.Z`, `X.Y`, and `latest`) and
   creates a GitHub Release from that CHANGELOG section.

## Developer Certificate of Origin

Commits must be signed off (`git commit -s`), certifying you wrote the
change or otherwise have the right to submit it under the project's
license, per the [Developer Certificate of Origin](https://developercertificate.org/):

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds this automatically using your configured git identity.

## Reporting bugs / security issues

Regular bugs and feature requests: open a GitHub issue using the provided
templates. Security vulnerabilities: see [SECURITY.md](SECURITY.md) --
please don't file those as public issues.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
