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
# Create an account
pixelvault register

# Upload an image — prints the URL to stdout
pixelvault upload screenshot.png
# https://img.pixelvault.dev/proj_abc/img_xyz.png

# Upload multiple images
pixelvault upload *.png --folder screenshots

# List your images
pixelvault list

# Delete an image
pixelvault delete img_xyz
```

## Agent Integration

The CLI is designed for AI coding agents. Output contract:

- `upload` prints **only the URL** to stdout
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
| `list` | List uploaded images |
| `delete <id>` | Delete an image |
| `whoami` | Show current auth state |
| `config get\|set\|show` | Manage CLI configuration |

### Upload Options

```bash
pixelvault upload photo.jpg              # Single file
pixelvault upload *.png --folder icons   # Bulk with folder
pixelvault upload shot.png --json        # Full JSON response
```

### List Options

```bash
pixelvault list                          # One URL per line
pixelvault list --json                   # Full JSON with metadata
pixelvault list --page 2 --per-page 50   # Pagination
```

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

## License

MIT
