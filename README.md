# gpt-image-mcp

MCP server for GPT Image generation via **ChatGPT subscription** — no OpenAI API key required.

Uses the same OAuth flow as the Codex CLI. If you have a ChatGPT Plus or Pro subscription, you can generate images for free (within your plan limits).

## Requirements

- Node.js 20+
- ChatGPT Plus or Pro subscription

## Setup

### Option A — global install (recommended)

```bash
npm install -g gpt-image-mcp
```

Add to Claude Code:

```bash
claude mcp add gpt-image -- gpt-image-mcp
```

### Option B — run from source

```bash
git clone https://github.com/YOUR_USERNAME/gpt-image-mcp
cd gpt-image-mcp
npm install && npm run build
claude mcp add gpt-image -- node /absolute/path/to/dist/index.js
```

### Option C — npx (no install)

```bash
claude mcp add gpt-image -- npx -y gpt-image-mcp
```

## First-time authentication

After adding the MCP server, open Claude Code and use the **`auth_login`** tool:

```
Use the auth_login tool
```

A browser window will open. Log in with your ChatGPT account. Once authenticated, your credentials are saved to `~/.gpt-image-mcp/auth.json` and reused automatically (tokens auto-refresh).

## Usage in Claude Code

```
Generate an image of a futuristic city at sunset
```

```
Generate a photorealistic portrait of a cat wearing glasses, high quality, 1792x1024
```

```
Edit the image at /path/to/photo.jpg — make it look like a watercolor painting
```

## Available tools

| Tool | Description |
|------|-------------|
| `auth_login` | Opens browser OAuth flow, saves credentials |
| `auth_status` | Check authentication status and token expiry |
| `auth_logout` | Clear saved credentials |
| `generate_image` | Text-to-image generation |
| `edit_image` | Image-to-image transformation with a reference image |

### `generate_image` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | Image description |
| `model` | string | `gpt-5.4-mini` | `gpt-5.4-mini` / `gpt-5.4` / `gpt-5.5` |
| `quality` | string | `medium` | `low` / `medium` / `high` |
| `size` | string | `1024x1024` | `1024x1024` / `1792x1024` / `1024x1792` / `512x512` |
| `output_path` | string | `~/.gpt-image-mcp/images/<uuid>.png` | Custom save path |

## How it works

This server uses the same OAuth 2.0 + PKCE flow as the official [Codex CLI](https://github.com/openai/codex). After authenticating, it calls `chatgpt.com/backend-api/codex/responses` with the `image_generation` tool — the same backend used by ChatGPT's web interface.

Token refresh is automatic. Credentials are stored at `~/.gpt-image-mcp/auth.json` (mode 600).

## Models

| Model | Speed | Quality | Notes |
|-------|-------|---------|-------|
| `gpt-5.4-mini` | Fast | Good | Default, great for iteration |
| `gpt-5.4` | Medium | Better | Balanced choice |
| `gpt-5.5` | Slow | Best | Highest quality, uses more quota |

## License

MIT
