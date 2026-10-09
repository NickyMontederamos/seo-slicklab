# Deploying SEO-slicklab by file upload

For hosts where you only have FTP or a file manager (no SSH). The zip already contains
the Node packages, so there is no `npm install` step.

## Before you start
- Your server needs **Node.js 18.17 or newer**. If audits stop working after the upload,
  this is the first thing to check (hosting panel → "Setup Node.js App", or ask your host).
- **Back up** the current site folder: in the file manager, select it → Compress → download.

## Upload
1. Open the folder that serves **seo.slicklab.digital** (often `public_html/seo` or `seo.slicklab.digital/`).
2. Upload `seo-slicklab-deploy.zip` into that folder.
3. **Extract** it there and allow it to **overwrite** existing files.
4. **Do not delete** the existing `node_modules` folder first. Your server's Playwright
   (the headless browser) lives there and is not in the zip.
5. Delete the uploaded zip.

## Check it worked (5 minutes)
1. Open https://seo.slicklab.digital/ and audit `https://slicklab.digital/`.
   You should see a new **Risk flags** section under the score.
2. Security check: audit `http://169.254.169.254/`.
   You should get **"That address points to a private network and cannot be audited."**
3. Hidden-files check: open https://seo.slicklab.digital/mcp/server.js
   - **404 / Not Found** = good, the `.htaccess` rules are working (Apache/LiteSpeed).
   - **You see code** = your server is Nginx. Send `deploy/nginx-snippet.conf` to your host
     (or add it to the site config yourself) — nothing secret is exposed meanwhile, it is just source code.
   - **500 Internal Server Error on the whole site** = delete `.htaccess`, then use the Nginx snippet route.

## What is and isn't on the website
- **On the website:** `index.php` — the audit page, now with risk flags and the private-address guard.
- **Not on the website:** the MCP server (runs on your own computer with Claude) and the bots
  (cron jobs; see `bots/README.md`). Their files are in the zip but hidden by the rules above.
- Keep secrets (`bots/config.json`, service-account keys, `.env`) **outside** the web folder.
