# mamolli-pi-setup

Composite [pi package](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/docs/packages.md) bundling:

- [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) — Cursor provider extension
- **plan-workflow** — local plan/execute workflow (`/plan`, `/plan-status`, `/planexe`)

One install gives you both extensions on any pi instance.

## Quick setup

```bash
pi install git:github.com/mamolli/mamolli-pi-setup@v2
```

Merge into `~/.pi/agent/settings.json` (or copy from `settings.example.json`):

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5",
  "defaultThinkingLevel": "high",
  "hideThinkingBlock": true,
  "packages": [
    "git:github.com/mamolli/mamolli-pi-setup@v2"
  ]
}
```

**Important:** Remove a separate `"npm:pi-cursor-sdk"` entry if present — this package already loads it.

Restart pi or run `/reload`.

## Local development / smoke test

```bash
cd mamolli-pi-setup
npm install
pi -e .
```

Confirm `/plan`, `/plan-status`, `/planexe` and Cursor models are available.

## Updating

Tag a release in this repo, then:

```bash
pi install git:github.com/mamolli/mamolli-pi-setup@v2
```

Or run `pi update --extensions` to reconcile pinned git refs.

## What's included

| Extension | Source |
|-----------|--------|
| pi-cursor-sdk | npm dependency |
| plan-workflow | `./extensions/plan-workflow/` |

See [extensions/plan-workflow/README.md](./extensions/plan-workflow/README.md) for plan-workflow commands.

## Do not commit

- `auth.json`, API keys, Cursor credentials
- Session files, `.pi/npm/`, `.pi/git/` caches on target machines
