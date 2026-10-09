# SlickLab bots — setup

Four scheduled, **read-only** reporters. They never post to, submit to, or change any website.

| Bot | When | Needs | Tells you |
|---|---|---|---|
| `watchtower` | weekly | nothing | New error pages, new risk flags (hacked-site signs), score drops, crawler blocks |
| `rank-tracker` | weekly | Search Console | Queries that moved up/down 3+ positions, new and lost queries |
| `map-check` | weekly | Places API key | Your position for "software company Cebu City" etc., the review gap |
| `rival-scout` | monthly | rival URLs | Gaps vs. rivals, open ground, rivals' risk flags |

Each run writes `<reports_dir>/<bot>/<date>_<time>.md` + `.json` and starts with **What changed since last run**.

## 1. Verify your site in Google Search Console (once, ~10 min)

You do this at your domain registrar — nothing here touches DNS.

1. Go to https://search.google.com/search-console → **Add property** → **Domain** → enter `slicklab.digital`.
2. Google shows a TXT record like `google-site-verification=AbC123…`. Copy it.
3. At your registrar's DNS settings, add **one** record:
   - **Type:** `TXT`
   - **Host / Name:** `@` (some registrars want it blank)
   - **Value:** the `google-site-verification=…` text, exactly
   - **TTL:** default
4. Back in Search Console, click **Verify**. If it fails, wait 15–60 minutes for DNS to spread and try again.

Data starts filling in after a few days.

## 2. Service account for the rank tracker

1. https://console.cloud.google.com → create a project (e.g. `slicklab-seo`).
2. **APIs & Services → Library** → enable **Google Search Console API**.
3. **IAM & Admin → Service accounts** → create one (no roles needed) → **Keys → Add key → JSON**. Download it.
4. In Search Console → **Settings → Users and permissions → Add user** → paste the service account's email → permission **Restricted** (read-only is all it needs).
5. Put the key **outside the web root**, e.g. `/etc/slicklab/sa.key.json`, `chmod 600`.

## 3. Places API key for the map check

1. Same Cloud project → enable **Places API (New)**.
2. **Credentials → Create credentials → API key**.
3. **Restrict the key**: API restrictions → only *Places API (New)*; application restrictions → your server's IP.
4. Set a budget alert in **Billing**. Weekly checks of a few queries are very low volume — check current pricing when you enable it.

## 4. Configure

```bash
cp bots/config.example.json bots/config.json   # git-ignored; edit site, rivals, queries
```

Secrets go in an env file outside the web root, e.g. `/etc/slicklab/bots.env` (`chmod 600`):

```bash
GOOGLE_APPLICATION_CREDENTIALS=/etc/slicklab/sa.key.json
PLACES_API_KEY=your-key
PLAYWRIGHT_BROWSERS_PATH=/var/cache/playwright
REPORT_WEBHOOK_URL=https://hooks.slack.com/services/...   # optional: Slack or Discord webhook
SLICKLAB_REPORTS_DIR=/var/lib/slicklab-reports            # keep reports out of the web root
```

Try each bot once by hand:

```bash
set -a; . /etc/slicklab/bots.env; set +a
node bots/run.js watchtower
```

## 5. Schedule (crontab -e)

Times are server time; minutes are off the hour on purpose.

```cron
SHELL=/bin/bash
# Mondays: site health, rankings, map
11 6 * * 1  cd /var/www/seo-slicklab && set -a && . /etc/slicklab/bots.env && set +a && node bots/run.js watchtower   >> /var/log/slicklab-bots.log 2>&1
23 6 * * 1  cd /var/www/seo-slicklab && set -a && . /etc/slicklab/bots.env && set +a && node bots/run.js rank-tracker >> /var/log/slicklab-bots.log 2>&1
37 6 * * 1  cd /var/www/seo-slicklab && set -a && . /etc/slicklab/bots.env && set +a && node bots/run.js map-check    >> /var/log/slicklab-bots.log 2>&1
# First of the month: rivals
47 6 1 * *  cd /var/www/seo-slicklab && set -a && . /etc/slicklab/bots.env && set +a && node bots/run.js rival-scout  >> /var/log/slicklab-bots.log 2>&1
```

## Notes

- The crawler obeys robots.txt, crawls 2 pages at a time with a pause, and runs the cloaking checks on the first page only.
- Map positions come from the official Places API and are close to, not identical to, what each person sees in the Maps app.
- Search, map and AI results move slowly. Read the monthly trend, not week-to-week noise.
