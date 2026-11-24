# mcp-server-kit

[README.md](README.md) covers what the kit is for, its public API, and how servers adopt it. This file holds what an agent changing the kit needs beyond that.

## Commands

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run audit
bun run fixture   # a sample server built from the kit
```

There is no CI. Run typecheck, lint, and tests before opening a pull request, and paste the results into it.

## Conventions

- Bun + TypeScript, no build step. Consumers import `src/` directly.
- Each source file opens with a comment saying what it owns. Keep comments evergreen: describe the code as it is.
- Lint is Oxlint with Cloudflare's preset plus three vendored anti-slop rules ([oxlint.config.ts](oxlint.config.ts), [tools/oxlint/anti-slop/UPSTREAM.md](tools/oxlint/anti-slop/UPSTREAM.md)). Keep a reason beside every rule the config turns off. Typecheck stays a separate step.
- The repository is public. Code, fixtures, commits, and PRs never name a machine, hostname, network, or vault from anyone's own setup.

## Install policy

`bunfig.toml` gates installs. Keep it.

- A package version younger than 3 days is not eligible, which defends against a malicious publish.
- `frozenLockfile = true`, so commit `bun.lock`. To add a package, set it to `false` for that one `bun add`, then restore it in the same diff.
- `exact = true`: `bun add <pkg>` saves the version without a caret.

## Factory

Read [the factory guide](docs/agents/factory.md) before taking on work, reviewing, or merging, and follow its workflow. When changing how work is checked or merged, update that guide in the same change.
