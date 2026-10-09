# slicklab-seo-mcp

An MCP server that gives Claude (or any MCP client) the SEO-slicklab engine as tools.
Every tool is **read-only**: it fetches public pages and reports. It never posts,
submits, or changes anything on any site.

## Tools

| Tool | What it does | Speed |
|---|---|---|
| `audit_site` | Full 10-engine audit of one URL: what to fix first (ranked by impact), plus ready-to-paste robots.txt, llms.txt and schema built from the page (`include_fixes`) | 10–60 s |
| `compare_rivals` | Audits your site + up to 8 rivals. Reports **where rivals beat you**, **open ground nobody covers**, and **where you lead** | ~30 s per site |
| `check_ai_access` | robots.txt rules for 12 AI/search crawlers, llms.txt, schema and JS-shell check in raw HTML | a few seconds per URL |
| `crawl_site` | Every page from sitemap.xml (robots.txt respected): duplicate titles/descriptions, missing H1s, error pages, noindex-in-sitemap, thin pages, risk flags | ~2 s per page |
| `gsc_performance` | Your real Google queries, clicks and average positions vs. the previous period (Search Console) | seconds |
| `gsc_inspect_url` | Is this URL indexed, when was it crawled, which canonical Google picked | seconds |
| `local_pack_check` | Your position in Google's local results and the review gap (Places API) | seconds |

The Google tools need keys — see [`bots/README.md`](../bots/README.md) for the 10-minute setup.
Scheduled versions of these run as cron bots on your server (same guide).

## Risk flags (spam policy & AI manipulation)

Every audit also runs `engines/risk.js`. Its flags sit **next to** the score and never change it:

| Flag | What it catches |
|---|---|
| Hidden text addressed to AI systems | Concealed text that speaks to assistants ("note to AI assistants: …") — indirect prompt injection, and a common sign of a hacked site |
| AI-addressed text in comments, meta, alt text, JSON-LD | The same, in places visitors never see |
| Hidden / spam-category links | Concealed outbound links, gambling/pharma/loan links |
| Cloaking | Googlebot or GPTBot gets different content than visitors |
| Server refuses GPTBot | A firewall/CDN rule blocks it even if robots.txt allows it |
| Sneaky redirects, keyword stuffing | Straight from Google's spam policies |

The detector only fires on text that *addresses* an AI system, so a page that merely talks
about AI ("our AI assistant writes captions") stays clean. Hidden-by-colour and off-screen
text needs the rendered page (Playwright); everything else works on raw HTML.
Skip with `--no-risk`.

**Agent safety.** Tool output is built from third-party pages. Page text is flattened and any
sentence addressed to an AI system is redacted; risk evidence is shown datamarked as
`UNTRUSTED⟦words·joined·like·this⟧`, and the server's MCP instructions tell clients to treat
it as data. For rivals with real violations, reports link to Google's spam report form.

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
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to the Search Console service-account JSON key (outside the web root) |
| `PLACES_API_KEY` | Places API (New) key, restricted to that API and your server IP |

## Safety notes

- URLs resolving to private, loopback or link-local addresses (e.g. cloud metadata at
  `169.254.169.254`) are refused unless `SLICKLAB_ALLOW_PRIVATE=1`. Redirects are not re-checked.
- The repo root is also the PHP web root. If you deploy by pulling the repo, block web
  access to `mcp/`, `test/`, `node_modules/` and `package*.json`, and keep API keys in
  environment variables, never in the repo.
