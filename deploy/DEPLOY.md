# Deploying seo.slicklab.digital

The site runs straight from this git repo on the VPS (aaPanel + Nginx, PHP 8, Node 18.17+).
Updates are one command, so nothing gets lost the way folder uploads can lose files.

## First time (run as root over SSH)

```bash
cd /www/wwwroot/seo.slicklab.digital
git init -q
git remote add origin https://github.com/NickyMontederamos/seo-slicklab.git
git fetch -q origin main
git reset --hard origin/main          # replaces tracked files; .user.ini and .well-known stay
npm ci --omit=dev --omit=optional --no-audit --no-fund
chown -R www:www . 2>/dev/null        # .user.ini is locked by aaPanel; its error is harmless
```

If the repo is private, `git fetch` asks for a login. Add a read-only deploy key instead:
`ssh-keygen -t ed25519 -f ~/.ssh/seo_slicklab -N ""`, paste `~/.ssh/seo_slicklab.pub` into
GitHub → repo Settings → Deploy keys, then use
`git remote set-url origin git@github.com:NickyMontederamos/seo-slicklab.git` and
`GIT_SSH_COMMAND="ssh -i ~/.ssh/seo_slicklab" git fetch origin main`.

## Nginx (once)

The site config needs the rule in `deploy/nginx-snippet.conf`, placed right after the
server-level `root` line in `/www/server/panel/vhost/nginx/seo.slicklab.digital.conf`.
If you already have the older rule (it lists only `index.php` and `.well-known`), replace it,
so `robots.txt`, `llms.txt` and `sitemap.xml` are served too. Then `nginx -t && nginx -s reload`.

## Every update

```bash
bash /www/wwwroot/seo.slicklab.digital/deploy/update.sh
```

## Check it worked

1. Open https://seo.slicklab.digital/ and check `https://slicklab.digital/`.
   You should see **Fix these first** with ranked findings and **Ready-to-paste files**.
2. Security: check `http://169.254.169.254/`. Expected: "That address points to a private network".
3. Hidden files: https://seo.slicklab.digital/seo-slicklab.js and /lib/limits.php should be **404**;
   /robots.txt, /llms.txt and /sitemap.xml should load.

## Limits (optional)

Set in the PHP-FPM environment (aaPanel → PHP → Configuration → `env[...]`) if you want to change them:
- `SLICKLAB_RATE_LIMIT`: checks per visitor per hour (default 5)
- `SLICKLAB_MAX_CONCURRENT`: checks running at once (default 2; each may start a browser)

## What is not on the website

The MCP server (runs on your own computer with Claude) and the bots (cron jobs; see
`bots/README.md`) live in the same repo but are hidden by the Nginx rule.
Keep secrets (`bots/config.json`, service-account keys, `.env`) **outside** the web folder.
