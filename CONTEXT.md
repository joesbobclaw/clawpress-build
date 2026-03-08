# ClawPress Build — Context Doc
*For Bob (or any AI agent) to read after compaction and pick up where we left off.*

## What This Is

An agentic site builder relay server. Node.js/Express app that receives a natural language prompt ("build me a coffee shop website"), runs a Claude tool-use agent loop against the WordPress REST API, and builds complete websites — pages, global styles, navigation menus, header/footer template parts, blog posts — all from a single prompt.

## Key Files

- `server.js` — Main server. Express app, Claude tool-use loop, WordPress REST API tool definitions, session locking, build logging.
- `prompts/site-builder-v1.md` — The system prompt. Heavily tuned. Covers content guidelines, style rules, WCAG contrast, column limits, template part requirements, efficiency rules.
- `prompts/site-builder-v1.json` — JSON version of the prompt (for programmatic use).
- `start.sh` — Launch script.
- `.env.example` — Required env vars: `ANTHROPIC_API_KEY`, `WP_SITE`, `WP_USER`, `WP_APP_PASSWORD`.
- `logo.jpg` — ClawPress logo used in the chatbox.

## Architecture

```
[Chatbox Widget on playground.newsy.us]
    ↓ POST /chat
[ClawPress Build Server (localhost:3847)]
    ↓ Claude API (tool-use loop, up to 20 iterations)
[WordPress REST API on target site]
    ↓ creates pages, sets styles, builds nav, etc.
[Complete website]
```

External access via Cloudflare tunnel (tunnel ID: c81b453d-144c-4b43-9a66-b8dc470632b3, config at ~/.cloudflared/config.yml).

## Key Decisions & Learnings

- **max_tokens must be 16384+** for Claude to generate full WordPress block HTML. Lower values truncate mid-block.
- **Loop breaker needed** — without it, Claude retries failed operations endlessly. Server caps at 20 iterations.
- **Slim API responses** — WordPress REST API returns massive JSON. We strip it down before feeding back to Claude to prevent context bloat.
- **One session at a time** — mutex lock prevents concurrent builds from colliding on the same WordPress site.
- **Image search gap** — Claude hallucinates Unsplash URLs. Needs a real image search tool integration (not yet built).
- **Max 2 columns** — 3-4 column WordPress layouts look terrible on narrow screens. Enforced in system prompt.
- **Mandatory header/footer** — if the agent skips custom template parts, the site shows broken default theme chrome.

## Deployment

- Live at playground.newsy.us (chatbox widget → Cloudflare tunnel → this server)
- Server runs on Joe's Mac (Family Computer)
- Started via `./start.sh` or `node server.js`
- Default port: 3847

## History

- Created: March 4-6, 2026
- 4 hours of iterative prompt tuning on March 6
- Test sites: Sacramento Vending, Alex Chen Photography, Harvest Hope, CloudSync
- Originally called "playground relay" — renamed to "clawpress-build" on March 8
- Previously lived inside bob-brain workspace at `projects/clawpress-playground/relay/`
