# pixelvault-cli

[![npm](https://img.shields.io/npm/v/pixelvault-cli)](https://www.npmjs.com/package/pixelvault-cli)
[![CI](https://github.com/pixelvault-dev/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/pixelvault-dev/cli/actions/workflows/ci.yml)

CLI for [PixelVault](https://pixelvault.dev) — agent-first image hosting for developers and AI coding agents.

## Install

```bash
npm install -g pixelvault-cli
```

Or use directly with `npx`:

```bash
npx pixelvault-cli upload photo.jpg
```

## Quick Start

```bash
# Create an account (prompts for email + optional password)
pixelvault register

# Non-interactive / agent signup — no password, key saved automatically
pixelvault register --email you@example.com --passwordless

# Upload an image — prints the URL to stdout
pixelvault upload screenshot.png
# https://img.pixelvault.dev/proj_abc/img_xyz.png

# Upload multiple images
pixelvault upload *.png --folder screenshots

# List your images
pixelvault list

# Get an image's URL, or download it (optionally transformed)
pixelvault get img_xyz                                     # prints the CDN URL
pixelvault get img_xyz -o photo.png                        # download the original
pixelvault get img_xyz -o thumb.webp -t "w=400&fmt=webp"   # download a transformed variant

# Delete an image
pixelvault delete img_xyz

# Check quota before a bulk upload
pixelvault usage

# Manage API keys (secret key required)
pixelvault keys list
KEY=$(pixelvault keys create --label ci)   # raw key on stdout, shown once
pixelvault keys revoke key_abc123

# Export everything — all your images as a tar archive (no lock-in)
pixelvault export -o my-images.tar
```

## Agent Integration

The CLI is designed for AI coding agents. Output contract:

- `upload` prints **only the URL** to stdout (add `--optimized` for the smaller WebP/AVIF variant; it falls back to the original URL for SVG, GIF and private uploads)
- `upload --idempotency-key <key>` makes retries safe: repeating the same key with the same file returns the original image instead of storing a copy (a note goes to stderr; single file only). `upload --dedupe` reuses an identical image already in your project without counting another upload. The two can't be combined
- `list` outputs one URL per line
- `delete` outputs nothing on success
- All human messages go to **stderr**
- `--json` flag for structured output

```bash
# In agent workflows
URL=$(npx pixelvault-cli upload screenshot.png)
echo "Uploaded to: $URL"
```

### Environment Variables

For CI/CD and headless agent usage:

```bash
export PIXELVAULT_API_KEY=pv_live_xxx
npx pixelvault-cli upload build-output.png
```

## Commands

| Command | Description |
|---------|-------------|
| `register` | Create a new account |
| `login` | Log in to existing account |
| `upload <files...>` | Upload images (prints URLs to stdout) |
| `generate <prompt>` | Generate an image from a prompt and host it (prints the URL; spends monthly AI credits) |
| `list` | List uploaded images |
| `get <id>` | Get an image's URL/metadata, or download it (optionally transformed) |
| `delete <id>` | Delete an image |
| `export` | Export all project images as a tar archive |
| `usage` | Show plan, period, storage/upload/bandwidth usage and limits, and AI generation credits |
| `keys list\|create\|revoke` | List, create, and revoke the project's secret API keys |
| `upgrade <starter\|pro>` | Print a Stripe Checkout URL to subscribe (live key; you pay in the browser) |
| `billing` | Print a Stripe billing-portal URL to change plan, update payment details or cancel (live key) |
| `whoami` | Show current auth state |
| `config get\|set\|show` | Manage CLI configuration |

### Upload Options

```bash
pixelvault upload photo.jpg              # Single file
pixelvault upload *.png --folder icons   # Bulk with folder
pixelvault upload shot.png --json        # Full JSON response
```

### Generate Options

```bash
pixelvault generate "flat vector hero, a robot at a laptop, no text"   # prints the hosted URL
pixelvault generate a red bicycle --optimized         # unquoted words work; print the WebP/AVIF URL
pixelvault generate "an og card" --model lucid-origin # Leonardo model (20 credits, paid plans)
pixelvault generate "a lake" --delete-after 1h        # auto-delete the image
pixelvault generate "a lake" --private --expires 12h  # signed link
```

Spends credits from your monthly grant: free 10 (`flux-1-schnell` only), Starter 300, Pro 1,500. `flux-1-schnell`
and the SDXL models cost 1 credit, the Leonardo models (`lucid-origin`, `phoenix-1.0`) cost 20. A failed
generation is refunded. stdout is just the URL (or `--json` for the full response); the credits used and left go to
stderr. Needs a secret key and a verified email. `pixelvault usage` shows your credits.

### Get Options

```bash
pixelvault get img_xyz                              # print the CDN URL to stdout
pixelvault get img_xyz --json                       # full metadata
pixelvault get img_xyz -o photo.png                 # download the original to a file
pixelvault get img_xyz -o cut.png -t "segment=foreground"   # download a transparent cut-out
pixelvault get img_xyz -t "w=400&fmt=webp"          # just print the transformed URL
```

Transform params (`-t`/`--transform`) are the same URL params documented at
<https://pixelvault.dev/docs#transforms> — resize (`w`/`h`/`fit`), format (`fmt`),
background removal (`segment=foreground`), effects (`blur`/`saturation`/`rotate`/…),
and watermark (`tile=img_logo.png` — another of your own images). Reserved
characters in values are percent-encoded for you (e.g. `background=#ffaa00`).

### Export Options

```bash
pixelvault export                          # download all your images to pixelvault-export-<job>.tar
pixelvault export -o backup.tar            # choose the output path
pixelvault export --extract                # untar into a directory after download (needs `tar`)
pixelvault export --timeout 900            # wait up to 900s for a large export (default 600)
pixelvault export --json                   # emit the final job JSON (archive path still to stdout)
```

`export` downloads **every image in your project** plus a `manifest.json` (ids,
filenames, storage keys, URLs, metadata) as a single tar archive — the free,
no-lock-in "take your data anywhere" command. It's async: the CLI starts the job,
polls until it's ready, then downloads. The archive path goes to **stdout**,
progress to **stderr**.

### List Options

```bash
pixelvault list                          # One URL per line
pixelvault list --json                   # Full JSON with metadata
pixelvault list --page 2 --per-page 50   # Pagination
```

### Usage and Keys

Both need a **secret** key (`pv_live_...`); publishable keys get a 403.

```bash
pixelvault usage                  # plan, period, used / limit / remaining
pixelvault usage --json           # the API `data` object

pixelvault keys list              # id, type, env, prefix, label, last used
pixelvault keys create --label ci --env live
pixelvault keys revoke key_abc123
```

- `usage` reports storage and uploads against your limits; bandwidth shows
  only its monthly limit (usage is not reported).
- `keys create` prints **only the raw key** to stdout (the "shown once" warning
  goes to stderr), so `KEY=$(pixelvault keys create)` works. The key is never
  shown again: store it in a secret manager and never commit it or log it.
  `--json` prints the whole data object instead.
- Limits: max 25 keys per project; 20 key changes per hour (429 includes
  `Retry-After`). Only secret keys can be revoked, and the key making the
  request cannot revoke itself.
- **Rotate a key**: `NEW=$(pixelvault keys create --label rotated)`, switch
  `PIXELVAULT_API_KEY` to `$NEW`, then `pixelvault keys revoke <old-id>` using
  the new key. If you get locked out, use the dashboard's Regenerate.

### Upgrade and billing

Both need a **live** secret key (`pv_live_...`); test and publishable keys get a 403. They print a Stripe URL for **you** to open — nothing is charged by the command, and the plan changes only after Stripe confirms payment.

```bash
pixelvault upgrade starter        # or: pro → Checkout URL (needs a verified email)
pixelvault usage                  # after paying: shows the new plan
pixelvault billing                # portal URL: change plan, payment details, cancel
pixelvault upgrade pro --json     # { "url": "..." }
```

Show the URLs only to the account owner: the portal can cancel the subscription. Limited to 10 billing requests per hour per account.

## Configuration

Config is stored at `~/.pixelvault/config.json` (0600 permissions).

```bash
pixelvault config show                   # Show all config
pixelvault config set api_url http://localhost:8787  # Dev override
pixelvault config get api_key            # Get a value
```

`PIXELVAULT_API_KEY` env var always takes precedence over the config file.

## Requirements

- Node.js 20+

## Learn more

- [PixelVault](https://pixelvault.dev) — agent-first image hosting
- [API docs](https://pixelvault.dev/docs/) — full REST reference + OpenAPI 3.1
- [Guide: Image hosting for AI agents](https://pixelvault.dev/blog/image-hosting-for-ai-agents/)
- [The simplest image hosting API](https://pixelvault.dev/image-hosting-api/)
- [Agent skill](https://github.com/pixelvault-dev/skill) — for Claude Code, Codex, and Cursor
- SDKs for use from code: [`@pixelvault-dev/sdk`](https://www.npmjs.com/package/@pixelvault-dev/sdk) (JavaScript/TypeScript) and [`pixelvault`](https://pypi.org/project/pixelvault/) (Python)

## License

MIT
