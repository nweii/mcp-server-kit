# Upstream

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit `13909c9e07590f5a85d93c62712259fe14a883f7` (MIT, see `LICENSE`), by way of the copy in [nweii/obsidian-remote-mcp](https://github.com/nweii/obsidian-remote-mcp). These files belong to this repository now; edit them to fit it.

## Local changes

- Only three rules are kept: `no-module-mocking`, `no-shape-in-symbol-names`, and `require-safety-comment-for-type-assertion`. The Cloudflare preset's `quality/` rules cover the rest of anti-slop's generic rules, so vendoring them again would report each finding twice.
- `no-module-mocking` also rejects Bun's `mock.module` imported from `bun:test`.
