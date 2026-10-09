<?php
declare(strict_types=1);

require __DIR__ . '/lib/limits.php';

$NODE = getenv('SLICKLAB_NODE') ?: '/usr/bin/node';
$SCRIPT = __DIR__ . '/seo-slicklab.js';
$PW_PATH = '/var/cache/playwright';
$TIMEOUT = 60;
$SITE = 'https://seo.slicklab.digital/';
$CONTACT = 'https://slicklab.digital/contact/';
$RATE_MAX = (int)(getenv('SLICKLAB_RATE_LIMIT') ?: 5);        // audits per visitor per hour
$SLOTS = (int)(getenv('SLICKLAB_MAX_CONCURRENT') ?: 2);       // audits running at once

function esc(?string $s): string {
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
function s($v): string { return is_scalar($v) ? (string)$v : ''; }
function impact_class(string $i): string { return ['high' => 'critical', 'medium' => 'warn', 'low' => 'good'][$i] ?? 'warn'; }
function impact_label(string $i): string { return ['high' => 'High impact', 'medium' => 'Medium impact', 'low' => 'Low impact'][$i] ?? 'Impact'; }
function sev_class(string $s): string { return ['critical' => 'critical', 'warning' => 'warn'][$s] ?? 'good'; }
function score_class(int $n): string { return $n >= 85 ? 'good' : ($n >= 60 ? 'warn' : 'critical'); }

/**
 * Visitors choose the URL, so refuse anything that resolves to this server or a
 * private network (localhost, LAN, cloud metadata at 169.254.169.254, ...).
 * The engine re-checks every redirect and browser request in public mode.
 */
function ip_is_public(string $ip): bool {
    if (stripos($ip, '::ffff:') === 0 && filter_var(substr($ip, 7), FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        $ip = substr($ip, 7);
    }
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return false;
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        $n = ip2long($ip);
        foreach ([['100.64.0.0', 10], ['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 3]] as [$net, $bits]) {
            $mask = -1 << (32 - $bits);
            if (($n & $mask) === (ip2long($net) & $mask)) return false;
        }
    } else {
        $l = strtolower($ip);
        if ($l === '::1' || $l === '::' || preg_match('/^(fc|fd|fe8|fe9|fea|feb|ff)/', $l)) return false;
    }
    return true;
}

function url_target_error(string $url): ?string {
    $host = strtolower(trim((string)parse_url($url, PHP_URL_HOST), '[]'));
    if ($host === '') return 'That doesn\'t look like a web address.';
    if ($host === 'localhost' || preg_match('/\.(localhost|internal)$/', $host)) {
        return 'That address points to a private network and cannot be audited.';
    }
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips = [$host];
    } else {
        $ips = gethostbynamel($host) ?: [];
        foreach (@dns_get_record($host, DNS_AAAA) ?: [] as $r) {
            if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
        }
        if (!$ips) return 'Could not find that domain. Check the spelling.';
    }
    foreach ($ips as $ip) {
        if (!ip_is_public($ip)) return 'That address points to a private network and cannot be audited.';
    }
    return null;
}

function run_cli_audit(string $node, string $script, string $pwPath, string $url, int $timeout,
                       ?string &$error, bool $noHeadless = false): ?array {
    $args = [$node, $script, $url, '--format', 'json', '--quiet'];
    if ($noHeadless) $args[] = '--no-headless';
    $env = ['PLAYWRIGHT_BROWSERS_PATH' => $pwPath, 'SLICKLAB_PUBLIC_MODE' => '1'];
    $proc = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    if (!is_resource($proc)) { $error = 'The audit engine could not start. Please try again later.'; return null; }
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($proc);
    $j = strpos((string)$out, '{');
    $d = $j === false ? null : json_decode(substr($out, $j), true);
    if (!is_array($d)) {
        // Keep engine internals out of the page; the server log gets the detail.
        error_log('seo-slicklab engine: ' . substr(trim($err . ' ' . $out), 0, 500));
        $error = 'The audit didn\'t finish. The site may be down, very slow, or blocking automated checks.';
        return null;
    }
    return $d;
}

$url = trim((string)($_POST['url'] ?? $_GET['url'] ?? ''));
$run = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && ($_POST['run_audit'] ?? '') === '1';
$audit = null;
$error = null;

if ($run && $url !== '') {
    if (!preg_match('#^https?://#i', $url)) $url = 'https://' . $url;
    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        $error = 'That doesn\'t look like a web address.';
    } elseif (!in_array(parse_url($url, PHP_URL_SCHEME), ['http', 'https'], true)) {
        $error = 'Only http:// and https:// addresses can be checked.';
    } elseif (($why = url_target_error($url)) !== null) {
        $error = $why;
    } elseif (!is_file($SCRIPT)) {
        $error = 'The audit engine is not installed on this server.';
    } else {
        if (random_int(1, 50) === 1) rate_limit_gc();
        [$allowed, $wait] = rate_limit_take((string)($_SERVER['REMOTE_ADDR'] ?? ''), $RATE_MAX);
        if (!$allowed) {
            $error = sprintf('You\'ve run %d checks in the last hour. Try again in about %d minute%s.',
                $RATE_MAX, (int)ceil($wait / 60), ceil($wait / 60) == 1 ? '' : 's');
        } elseif (!($slot = audit_slot_take($SLOTS))) {
            $error = 'Other checks are running right now. Please try again in a minute.';
        } else {
            try {
                @set_time_limit($TIMEOUT * 2 + 30);
                $audit = run_cli_audit($NODE, $SCRIPT, $PW_PATH, $url, $TIMEOUT, $error);
                if ($audit === null) {
                    $error = null;
                    $audit = run_cli_audit($NODE, $SCRIPT, $PW_PATH, $url, $TIMEOUT, $error, true);
                }
            } finally {
                audit_slot_release($slot);
            }
        }
    }
}

$advice = is_array($audit['advice'] ?? null) ? $audit['advice'] : null;
$host = $audit ? (string)parse_url((string)($audit['final_url'] ?? $url), PHP_URL_HOST) : '';
$title = $audit ? "Audit: $host | SlickLab.Digital" : 'Free SEO & AI Visibility Check | SlickLab.Digital';
$description = 'Check if Google and AI assistants like ChatGPT can find, read and quote your website. Free, no sign-up. Get your top 5 fixes and ready-to-paste files.';
$faq = [
    ['Is it free?', 'Yes. Each visitor can run 5 checks an hour, so the server stays quick for everyone.'],
    ['Do you store my results?', 'No. Results are shown once and not saved. To enforce the hourly limit we keep a scrambled (hashed) version of your IP address for one hour.'],
    ['Will a high score get me ranked or recommended by AI?', 'No. Nobody controls rankings or what an AI recommends, and anyone selling that is selling nothing. The check makes sure search engines and assistants can reach your site, read it, and get your facts right.'],
    ['What is llms.txt?', 'A plain-text file at the root of your site that describes your business for AI tools. It is a young convention, not an official standard, and takes about 20 minutes to write. The check drafts one from facts on your homepage.'],
];
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= esc($title) ?></title>
<meta name="description" content="<?= esc($description) ?>">
<?php if ($audit): ?>
<meta name="robots" content="noindex">
<?php else: ?>
<link rel="canonical" href="<?= esc($SITE) ?>">
<?php endif; ?>
<meta property="og:type" content="website">
<meta property="og:title" content="Free SEO &amp; AI Visibility Check">
<meta property="og:description" content="<?= esc($description) ?>">
<meta property="og:url" content="<?= esc($SITE) ?>">
<meta name="author" content="SlickLab.Digital">
<script type="application/ld+json"><?= json_encode([
    '@context' => 'https://schema.org',
    '@graph' => [
        [
            '@type' => 'WebApplication',
            '@id' => $SITE . '#app',
            'name' => 'SEO & AI Visibility Check',
            'url' => $SITE,
            'description' => $description,
            'applicationCategory' => 'BusinessApplication',
            'operatingSystem' => 'Any (runs in the browser)',
            'offers' => ['@type' => 'Offer', 'price' => '0', 'priceCurrency' => 'USD'],
            'provider' => ['@id' => 'https://slicklab.digital/#organization'],
        ],
        [
            '@type' => 'ProfessionalService',
            '@id' => 'https://slicklab.digital/#organization',
            'name' => 'SlickLab.Digital',
            'url' => 'https://slicklab.digital/',
        ],
        [
            '@type' => 'FAQPage',
            'mainEntity' => array_map(fn($q) => [
                '@type' => 'Question', 'name' => $q[0],
                'acceptedAnswer' => ['@type' => 'Answer', 'text' => $q[1]],
            ], $faq),
        ],
    ],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?></script>
<style>
/* Ledger layout: one column of bordered panels; the ranked fix list is the centre of gravity. */
:root{
  --ink:#17211F;--muted:#55615D;--paper:#F4F3EE;--raised:#FFFFFF;--line:#DEDCD1;--code:#F7F6F1;
  --accent:#0B6B5C;--accent-ink:#FFFFFF;--accent-soft:#E4EFEC;
  --good:#2E7D4F;--good-soft:#E4F0E8;--warn:#9A6316;--warn-soft:#F6EBDA;--critical:#B3392C;--critical-soft:#FBEAE7;
  --display:Georgia,"Iowan Old Style","Palatino Linotype",serif;
  --body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --ink:#EDEAE2;--muted:#A9B3AE;--paper:#14201C;--raised:#1B2A25;--line:#2C3A34;--code:#16231F;
  --accent:#4FBFA5;--accent-ink:#0E1A16;--accent-soft:#1E332C;
  --good:#6FCB94;--good-soft:#1D3226;--warn:#E0A559;--warn-soft:#362A16;--critical:#E37B6B;--critical-soft:#3A211C;
  color-scheme:dark;
}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--paper);color:var(--ink);font:400 16px/1.6 var(--body)}
a{color:var(--accent)}
.wrap{max-width:880px;margin:0 auto;padding:28px 16px 64px;display:flex;flex-direction:column;gap:20px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:600}
.mark{width:36px;height:36px;border-radius:6px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font:600 15px var(--display)}
h1,h2,h3{font-family:var(--display);font-weight:600;line-height:1.2;margin:0;text-wrap:balance}
h1{font-size:clamp(1.75rem,4vw,2.4rem)}
h2{font-size:1.4rem}
h3{font-size:1.1rem}
p{margin:0}
.lede{font-size:1.1rem;color:var(--muted);max-width:62ch}
.panel{background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:22px;display:flex;flex-direction:column;gap:14px;min-width:0}
form.check{display:flex;gap:10px;flex-wrap:wrap}
form.check input{flex:1 1 260px;min-width:0;padding:12px 14px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:500 16px var(--mono)}
form.check input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.btn{display:inline-block;padding:12px 20px;border-radius:6px;border:0;background:var(--accent);color:var(--accent-ink);font:600 15px var(--body);cursor:pointer;text-decoration:none}
.btn:disabled{opacity:.6;cursor:wait}
.btn:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.hint{font-size:.875rem;color:var(--muted)}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.grid3 > div{display:flex;flex-direction:column;gap:4px}
.error{background:var(--critical-soft);color:var(--critical);border:1px solid var(--critical);border-radius:6px;padding:12px 16px}
.status{display:inline-block;padding:.12rem .5rem;border-radius:3px;font:600 .72rem var(--body);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.status.good{background:var(--good-soft);color:var(--good)}
.status.warn{background:var(--warn-soft);color:var(--warn)}
.status.critical{background:var(--critical-soft);color:var(--critical)}
.result-head{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.score{flex:none;text-align:center;min-width:110px;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--paper)}
.score b{display:block;font:600 2.6rem/1 var(--mono);font-variant-numeric:tabular-nums}
.score b.good{color:var(--good)} .score b.warn{color:var(--warn)} .score b.critical{color:var(--critical)}
.score span{font-size:.75rem;color:var(--muted)}
.result-head .text{flex:1 1 300px;display:flex;flex-direction:column;gap:8px;min-width:0}
.meta{font:500 .8rem var(--mono);color:var(--muted);word-break:break-all}
ol.fixes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0;counter-reset:fix}
ol.fixes > li{counter-increment:fix;display:grid;grid-template-columns:2.2rem 1fr;gap:4px 10px;padding:16px 0;border-top:1px solid var(--line)}
ol.fixes > li:first-child{border-top:0;padding-top:0}
ol.fixes > li::before{content:counter(fix);font:600 1.1rem var(--mono);color:var(--muted);grid-row:span 8}
.tags{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.effort{font-size:.8rem;color:var(--muted)}
.why{color:var(--muted);word-break:break-word}
.do{word-break:break-word}
.do strong{color:var(--accent)}
.copy{position:relative;border:1px solid var(--line);border-radius:6px;background:var(--code)}
.copy pre{margin:0;padding:44px 14px 14px;max-height:24rem;overflow:auto;font:500 .8rem/1.5 var(--mono);white-space:pre}
.copy button{position:absolute;top:8px;right:8px;padding:6px 12px;border-radius:4px;border:1px solid var(--accent);background:var(--raised);color:var(--accent);font:600 .75rem var(--body);text-transform:uppercase;letter-spacing:.04em;cursor:pointer}
.file-head{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.file-head code{font:600 .9rem var(--mono);color:var(--accent)}
ul.plain{margin:0;padding-left:1.2rem;display:flex;flex-direction:column;gap:6px}
ul.rows{list-style:none;margin:0;padding:0}
ul.rows li{display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:10px;align-items:baseline;padding:10px 0;border-top:1px solid var(--line)}
ul.rows li > .status{justify-self:start}
ul.rows li:first-child{border-top:0}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{font-size:.85rem;padding:2px 10px;border-radius:999px;background:var(--good-soft);color:var(--good)}
.cta{background:var(--accent-soft);border-color:var(--accent)}
.bars{display:flex;flex-direction:column;gap:8px}
.bar{display:grid;grid-template-columns:minmax(0,1fr) 120px 2.5rem;gap:10px;align-items:center;font-size:.9rem}
.bar i{display:block;height:8px;border-radius:4px;background:var(--line);overflow:hidden}
.bar i b{display:block;height:100%}
.bar i b.good{background:var(--good)} .bar i b.warn{background:var(--warn)} .bar i b.critical{background:var(--critical)}
.bar span:last-child{font:600 .85rem var(--mono);text-align:right}
details summary{cursor:pointer;font-weight:600}
details pre{white-space:pre-wrap;word-break:break-word;font:500 .75rem/1.5 var(--mono);max-height:30rem;overflow:auto;background:var(--code);padding:12px;border-radius:6px;border:1px solid var(--line)}
.evidence{font:500 .8rem var(--mono);color:var(--muted);word-break:break-word}
footer{font-size:.8rem;color:var(--muted);display:flex;flex-direction:column;gap:4px}
@media (prefers-reduced-motion:no-preference){.btn{transition:opacity .15s}}
</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <a class="brand" href="https://slicklab.digital/"><span class="mark">SL</span>SlickLab.Digital</a>
  <a href="<?= esc($CONTACT) ?>">Get help with fixes</a>
</header>

<section class="panel">
  <h1>Can Google and AI assistants find your website?</h1>
  <p class="lede">Paste your homepage address. In about 30 seconds you get the five fixes that matter most, ranked, with files you can paste straight into your site. Free, no sign-up.</p>
  <form class="check" method="post" action="" id="check-form">
    <label for="url" class="hint" style="flex-basis:100%">Website address</label>
    <input type="text" inputmode="url" id="url" name="url" value="<?= esc($url) ?>" placeholder="yourbusiness.com" required autocomplete="url">
    <input type="hidden" name="run_audit" value="1">
    <button type="submit" class="btn" id="run-btn">Check my site</button>
  </form>
  <p class="hint" id="wait-note" hidden>Checking… this takes 20–40 seconds. Keep this page open.</p>
</section>

<?php if ($error): ?>
<div class="error" role="alert"><?= esc($error) ?></div>
<?php endif; ?>

<?php if ($audit):
  $score = (int)($audit['overall_score'] ?? 0);
  $status = (int)($audit['http_status'] ?? 0);
  $timing = $audit['fetch_timing'] ?? [];
  $risk = is_array($audit['risk'] ?? null) ? $audit['risk'] : null;
  $top = $advice['top'] ?? [];
  $appendix = $advice['appendix'] ?? [];
  $files = $advice['fixes'] ?? [];
  $fileNames = [];
  foreach ($files as $f) $fileNames[s($f['id'] ?? '')] = s($f['file'] ?? '');
?>

<section class="panel" aria-labelledby="result-title">
  <div class="result-head">
    <div class="score"><b class="<?= score_class($score) ?>"><?= $score ?></b><span>technical score / 100</span></div>
    <div class="text">
      <h2 id="result-title">Results for <?= esc($host) ?></h2>
      <p><?= esc(s($advice['headline'] ?? $advice['summary'] ?? '')) ?></p>
      <?php if (!empty($advice['strengths'])): ?>
      <div class="chips"><?php foreach (array_slice($advice['strengths'], 0, 5) as $st): ?><span class="chip">✓ <?= esc(s($st)) ?></span><?php endforeach; ?></div>
      <?php endif; ?>
      <p class="meta"><?= esc(s($audit['final_url'] ?? '')) ?> · HTTP <?= $status ?> · first byte <?= (int)($timing['ttfb_ms'] ?? 0) ?> ms · checked <?= esc(gmdate('j M Y, H:i', strtotime(s($audit['timestamp'] ?? 'now')) ?: time())) ?> UTC</p>
    </div>
  </div>
  <p class="hint">The score measures technical readiness only. It can't promise a ranking: nobody controls that.</p>
</section>

<?php if ($top): ?>
<section class="panel" aria-labelledby="top-title">
  <h2 id="top-title">Fix these first</h2>
  <ol class="fixes">
  <?php foreach ($top as $f): $imp = s($f['impact'] ?? ''); $file = $fileNames[s($f['fix_file'] ?? '')] ?? ''; ?>
    <li>
      <div class="tags"><span class="status <?= impact_class($imp) ?>"><?= esc(impact_label($imp)) ?></span><span class="effort"><?= esc(s($f['effort_label'] ?? '')) ?></span></div>
      <h3><?= esc(s($f['title'] ?? '')) ?></h3>
      <p class="why"><?= esc(s($f['why'] ?? '')) ?></p>
      <?php foreach (array_slice(is_array($f['evidence'] ?? null) ? $f['evidence'] : [], 0, 3) as $ev): ?>
      <p class="evidence">Quoted from your site: “<?= esc(s($ev)) ?>”</p>
      <?php endforeach; ?>
      <p class="do"><strong>Fix:</strong> <?= esc(s($f['fix'] ?? '')) ?><?php if ($file): ?> <a href="#file-<?= esc(s($f['fix_file'])) ?>">Get <?= esc($file) ?> ↓</a><?php endif; ?></p>
    </li>
  <?php endforeach; ?>
  </ol>
</section>
<?php endif; ?>

<?php if ($files): ?>
<section class="panel" aria-labelledby="files-title">
  <h2 id="files-title">Ready-to-paste files</h2>
  <p class="hint">Built only from what's on your homepage. Anything we couldn't confirm says TO CONFIRM; fill those in before you publish.</p>
  <?php foreach ($files as $f): ?>
  <div id="file-<?= esc(s($f['id'] ?? '')) ?>" style="display:flex;flex-direction:column;gap:6px">
    <div class="file-head"><code><?= esc(s($f['file'] ?? '')) ?></code><span class="hint"><?= esc(s($f['note'] ?? '')) ?></span></div>
    <div class="copy"><button type="button" class="copy-btn">Copy</button><pre><?= esc(s($f['content'] ?? '')) ?></pre></div>
  </div>
  <?php endforeach; ?>
</section>
<?php endif; ?>

<section class="panel cta">
  <h2>Want these fixed for you?</h2>
  <p>SlickLab.Digital, a studio in Cebu City, can apply these fixes and set up Google Search Console, your Business Profile and directory listings, all at published prices.</p>
  <p><a class="btn" href="<?= esc($CONTACT) ?>">Ask about fixes</a></p>
</section>

<?php if ($appendix): ?>
<section class="panel" aria-labelledby="more-title">
  <h2 id="more-title">More to do</h2>
  <ul class="rows">
  <?php foreach ($appendix as $f): $imp = s($f['impact'] ?? ''); ?>
    <li><span class="status <?= impact_class($imp) ?>"><?= esc(ucfirst($imp)) ?></span><span><strong><?= esc(s($f['title'] ?? '')) ?>.</strong> <span class="why"><?= esc(s($f['fix'] ?? '')) ?></span></span></li>
  <?php endforeach; ?>
  </ul>
</section>
<?php endif; ?>

<?php if ($risk):
  $rflags = $risk['flags'] ?? [];
  $rstatus = s($risk['status'] ?? 'clean');
?>
<section class="panel" aria-labelledby="risk-title">
  <div class="tags"><h2 id="risk-title">Spam-policy check</h2><span class="status <?= ['high' => 'critical', 'review' => 'warn'][$rstatus] ?? 'good' ?>"><?= esc($rstatus === 'clean' ? 'Clean' : ucfirst($rstatus)) ?></span></div>
  <?php if (!$rflags): ?>
  <p>No hidden text aimed at AI, hidden links, cloaking, sneaky redirects or keyword stuffing found.</p>
  <?php endif; ?>
  <ul class="rows">
  <?php foreach ($rflags as $rf): ?>
    <li style="display:flex;flex-direction:column;align-items:stretch;gap:4px">
      <div class="tags"><span class="status <?= sev_class(s($rf['severity'] ?? '')) ?>"><?= esc(s($rf['severity'] ?? '')) ?></span><strong><?= esc(s($rf['title'] ?? '')) ?></strong></div>
      <span class="why"><?= esc(s($rf['detail'] ?? '')) ?></span>
      <?php foreach (array_slice($rf['evidence'] ?? [], 0, 3) as $e): ?>
      <span class="evidence"><?= esc(s($e['where'] ?? '')) ?>: <?= esc(s($e['text'] ?? '')) ?></span>
      <?php endforeach; ?>
      <span class="do"><strong>Fix:</strong> <?= esc(s($rf['action'] ?? '')) ?></span>
    </li>
  <?php endforeach; ?>
  </ul>
</section>
<?php endif; ?>

<?php if (!empty($advice['not_checked'])): ?>
<section class="panel" aria-labelledby="nc-title">
  <h2 id="nc-title">What this check can't see</h2>
  <ul class="plain"><?php foreach ($advice['not_checked'] as $n): ?><li><?= esc(s($n)) ?></li><?php endforeach; ?></ul>
  <p class="hint">Search and AI visibility take about 30 days to change after a fix. Check again in a month, not next week.</p>
</section>
<?php endif; ?>

<section class="panel" aria-labelledby="eng-title">
  <h2 id="eng-title">Engine details</h2>
  <div class="bars">
  <?php foreach (($audit['modules'] ?? []) as $key => $m):
    if (($m['key'] ?? $key) === 'scoring_reporting') continue;
    $ms = (int)($m['score'] ?? 0); ?>
    <div class="bar"><span><?= esc(s($m['label'] ?? $key)) ?></span><i><b class="<?= score_class($ms) ?>" style="width:<?= $ms ?>%"></b></i><span><?= $ms ?></span></div>
  <?php endforeach; ?>
  </div>
  <details><summary>Full audit data (JSON)</summary><pre><?= esc((string)json_encode($audit, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) ?></pre></details>
</section>

<?php else: ?>

<section class="panel" aria-labelledby="what-title">
  <h2 id="what-title">What it checks</h2>
  <div class="grid3">
    <div><h3>Can they get in?</h3><p class="why">Your robots.txt rules for Google and for AI crawlers like GPTBot, ClaudeBot and PerplexityBot, plus noindex tags and bot walls.</p></div>
    <div><h3>Can they read it?</h3><p class="why">Whether your content shows without JavaScript, your structured data (schema.org), sitemap and llms.txt.</p></div>
    <div><h3>Are the facts right?</h3><p class="why">Phone numbers or countries that disagree, text that tries to steer AI, and Google spam-policy risks.</p></div>
  </div>
  <p>Nobody can make an AI recommend your business. This check makes sure assistants can reach your site, read it, and get your facts right.</p>
</section>

<section class="panel" aria-labelledby="faq-title">
  <h2 id="faq-title">Frequently asked questions</h2>
  <?php foreach ($faq as [$q, $a]): ?>
  <div style="display:flex;flex-direction:column;gap:4px"><h3><?= esc($q) ?></h3><p class="why"><?= esc($a) ?></p></div>
  <?php endforeach; ?>
</section>

<?php endif; ?>

<footer>
  <span>Built by <a href="https://slicklab.digital/">SlickLab.Digital</a>, Cebu City, Philippines. Results are not stored.</span>
  <span>SEO-slicklab engine · 10 audit engines, spam-policy flags and a fix advisor</span>
</footer>
</div>

<script>
(function () {
  var form = document.getElementById('check-form');
  if (form) form.addEventListener('submit', function () {
    var b = document.getElementById('run-btn'), n = document.getElementById('wait-note');
    if (b) { b.disabled = true; b.textContent = 'Checking…'; }
    if (n) n.hidden = false;
  });
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var pre = btn.nextElementSibling, text = pre.textContent;
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
      var select = function () {
        var r = document.createRange(); r.selectNodeContents(pre);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Press Ctrl+C';
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, select);
        else select();
      } catch (e) { select(); }
    });
  });
})();
</script>
</body>
</html>
