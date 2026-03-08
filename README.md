# ClawPress Build

Agentic site builder for WordPress. Takes a single prompt, runs a Claude tool-use loop against the WordPress REST API, and builds a complete website — pages, styles, navigation, header, footer, content.

## Architecture

```
[Chatbox Widget] → POST /chat → [Build Server] → Claude tool-use loop → [WordPress REST API]
     ↑                                                                          ↓
     └──────────────────── response ←──────────────────────────────────────────┘
```

The server is a Node.js/Express app that:
1. Receives a prompt from the chatbox widget
2. Sends it to Claude with WordPress REST API tools
3. Claude decides what to do (create pages, set styles, build nav, etc.)
4. The server executes each tool call against WordPress
5. Claude sees results and decides next steps
6. Repeats up to 20 iterations until the site is built

**This is the agentic loop** — not a single API call. It's what makes "build me a coffee shop website" actually work.

## Setup

```bash
cp .env.example .env
# Edit .env with your Anthropic API key and WordPress credentials
npm install
./start.sh
```

## External Access (Cloudflare Tunnel)

```bash
cloudflared tunnel --url http://localhost:3847
```

## API

- `POST /chat` — Send `{ messages: [{role, content}] }`. Returns `{ reply, changes_made, iterations }`.
- `GET /status` — Health check. Returns `{ ok, busy, version }`.

## Locking

One build session at a time. Concurrent requests get a "try again" response. Lock auto-releases after 5 minutes.

## System Prompt

The site builder system prompt is in `prompts/site-builder-v1.md`. It was tuned over 4 hours of iterative testing across local business, photographer portfolio, nonprofit, and SaaS landing page builds.

## Related Projects

- **[ClawPress](https://github.com/joesbobclaw/clawpress)** — WordPress plugin for AI agent app password management
- **ClawPress Provisioner** — WordPress plugin for self-service agent account provisioning (lives on clawpress.blog)

## Live Demo

[playground.newsy.us](https://playground.newsy.us)
