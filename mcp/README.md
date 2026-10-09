# slicklab-seo-mcp

An MCP server that gives Claude (or any MCP client) the SEO-slicklab engine as tools.
Every tool is **read-only**: it fetches public pages and reports. It never posts,
submits, or changes anything on any site.

## Tools

| Tool | What it does | Speed |
|---|---|---|
| `audit_site` | Full 10-engine audit of one URL, summarised (optionally with fix snippets) | 10–60 s |
| `compare_rivals` | Audits your site + up to 8 rivals. Reports **where rivals beat you**, **open ground nobody covers**, and **where you lead** | ~30 s per site |
| `check_ai_access` | robots.txt rules for 12 AI/search crawlers, llms.txt, schema and JS-shell check in raw HTML | a few seconds per URL |

## Install

```bash
npm install            # cheerio, MCP SDK, zod; playwright is optional
npm test               # unit + end-to-end tests against local fixture sites
```

Playwright is optional. Without it the audits run in raw-HTML mode and skip the
rendered-vs-raw comparison.

## Connect it

**Claude Code**

```bash
claude mcp add slicklab-seo -- node /absolute/path/to/seo-slicklab/mcp/server.js
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "slicklab-seo": {
      "command": "node",
      "args": ["/absolute/path/to/seo-slicklab/mcp/server.js"],
      "env": { "PLAYWRIGHT_BROWSERS_PATH": "/var/cache/playwright" }
    }
  }
}
```

Then ask: *"Compare slicklab.digital against symph.co and arcanys.com"*.

## Environment

| Variable | Purpose |
|---|---|
| `PLAYWRIGHT_BROWSERS_PATH` | Where Playwright browsers live (your server uses `/var/cache/playwright`) |
| `SLICKLAB_CHROMIUM_PATH` | Exact Chromium binary, when the playwright package and installed browsers are different versions |
| `SLICKLAB_ALLOW_PRIVATE=1` | Allow localhost / private-network URLs (local dev and tests only) |

## Safety notes

- URLs resolving to private, loopback or link-local addresses (e.g. cloud metadata at
  `169.254.169.254`) are refused unless `SLICKLAB_ALLOW_PRIVATE=1`. Redirects are not re-checked.
- The repo root is also the PHP web root. If you deploy by pulling the repo, block web
  access to `mcp/`, `test/`, `node_modules/` and `package*.json`, and keep API keys in
  environment variables, never in the repo.
