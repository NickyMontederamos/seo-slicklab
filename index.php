<?php
declare(strict_types=1);

require __DIR__ . '/lib/url-guard.php';
require __DIR__ . '/lib/rate-limit.php';

$NODE = '/usr/bin/node';
$SCRIPT = __DIR__ . '/seo-slicklab.js';
$PW_PATH = '/var/cache/playwright';
$TIMEOUT = 60;
$DEFAULT_URL = 'https://slicklab.digital/';
$RL_DIR = sys_get_temp_dir() . '/seo-slicklab-rl';
$RL_MAX_PER_IP = 5;        // audits per client IP...
$RL_WINDOW_SEC = 600;      // ...per 10 minutes
$MAX_CONCURRENT = 2;       // Chromium runs at once, server-wide
const ENGINE_EXIT_URL_NOT_ALLOWED = 3; // seo-slicklab.js exit code in public mode

function esc(?string $s): string {
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
function score_bucket(int $n): string {
    return $n >= 70 ? 'good' : ($n >= 50 ? 'warn' : 'bad');
}
function sev_class(string $s): string {
    return ['critical'=>'bad','warning'=>'warn','notice'=>'info'][$s] ?? 'info';
}

function run_cli_audit(string $node, string $script, string $pwPath,
                       string $url, int $timeout,
                       ?string &$rawOut, ?string &$error,
                       bool $noHeadless = false, ?int &$exitCode = null): ?array {
    $args = [$node, $script, $url, '--format', 'json', '--quiet'];
    if ($noHeadless) $args[] = '--no-headless';

    $desc = [
        0 => ['pipe','r'],
        1 => ['pipe','w'],
        2 => ['pipe','w'],
    ];
    // SLICKLAB_PUBLIC_MODE makes the engine re-check every fetch (redirect
    // hops, DNS answers, browser requests) against lib/url-guard.js.
    $env = ['PLAYWRIGHT_BROWSERS_PATH' => $pwPath, 'SLICKLAB_PUBLIC_MODE' => '1'];

    $proc = proc_open($args, $desc, $pipes, null, $env, ['timeout' => ($timeout + 15) * 1000000]);
    if (!is_resource($proc)) {
        if ($error === null) $error = 'Could not start engine process.';
        return null;
    }
    fclose($pipes[0]);
    $rawOut = stream_get_contents($pipes[1]);
    $errOut = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    $exitCode = $code;

    if ($code === ENGINE_EXIT_URL_NOT_ALLOWED) {
        $error = trim($errOut) !== '' ? trim($errOut) : URL_GUARD_NOT_ALLOWED_MSG;
        return null;
    }

    // Combine stdout + stderr for error reporting
    $combined = $rawOut . "\n" . $errOut;

    $j = strpos($rawOut, '{');
    if ($j === false) {
        if ($error === null) {
            $error = 'No JSON from engine. Raw: ' . htmlspecialchars(substr($combined, 0, 300));
        }
        return null;
    }
    $d = json_decode(substr($rawOut, $j), true);
    if (!is_array($d)) {
        if ($error === null) {
            $error = 'Bad JSON. Raw: ' . htmlspecialchars(substr($combined, 0, 300));
        }
        return null;
    }
    return $d;
}

$url = trim((string)($_POST['url'] ?? $_GET['url'] ?? $DEFAULT_URL));
$run = isset($_POST['run_audit']) && $_POST['run_audit'] === '1';
$audit = null;
$error = null;
$rawOut = null;

if ($run && $url !== '') {
    if (!preg_match('#^https?://#i', $url)) $url = 'https://' . $url;
    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        $error = 'Invalid URL.';
    } elseif (!in_array(parse_url($url, PHP_URL_SCHEME), ['http','https'], true)) {
        $error = 'Only http:// and https:// URLs are allowed.';
    } elseif (($guardError = url_guard_check($url)) !== null) {
        $error = $guardError;
    } elseif (!is_file($SCRIPT)) {
        $error = "Engine not found: $SCRIPT";
    } elseif (!rate_limit_allow((string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'),
                                $RL_MAX_PER_IP, $RL_WINDOW_SEC, $RL_DIR)) {
        $error = 'Too many audits from your address. Please wait a few minutes and try again.';
    } elseif (($slot = rate_limit_acquire_slot($RL_DIR, $MAX_CONCURRENT)) === null) {
        $error = 'The server is busy running other audits. Please try again in a minute.';
    } else {
        @set_time_limit($TIMEOUT + 30);
        $exitCode = null;
        $audit = run_cli_audit($NODE, $SCRIPT, $PW_PATH, $url, $TIMEOUT, $rawOut, $error, false, $exitCode);
        if ($audit === null && $exitCode !== ENGINE_EXIT_URL_NOT_ALLOWED) {
            $audit = run_cli_audit($NODE, $SCRIPT, $PW_PATH, $url, $TIMEOUT, $rawOut, $error, true);
        }
        if (is_resource($slot)) fclose($slot);
    }
}

$page_title = $audit ? esc((string)($audit['final_url'] ?? $url)) : 'SEO-slicklab';
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO-slicklab — <?= $page_title ?></title>
<style>
:root{--bg:#0d0f12;--panel:#15181d;--panel-2:#1b1f26;--border:#2a2f38;--text:#d6dae0;--muted:#7a808a;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#58a6ff;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;min-height:100vh}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:18px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:14px;font-weight:600;margin:22px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}
.muted{color:var(--muted)}
.mono{font-family:var(--mono);font-size:12px}
a{color:var(--accent)}
.toolbar{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin-bottom:18px}
.toolbar label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.toolbar input[type="url"]{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:10px 12px;border-radius:6px;font-size:14px;font-family:var(--mono)}
.toolbar input[type="url"]:focus{outline:none;border-color:var(--accent)}
.row{display:flex;gap:10px;align-items:flex-end;margin-top:10px}
.btn{background:var(--accent);color:#0d0f12;border:none;padding:9px 18px;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.5;cursor:wait}
.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}
.status-bar{display:flex;flex-wrap:wrap;gap:10px 18px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:13px}
.status-bar .item{display:flex;align-items:center;gap:6px}
.status-bar .dot{width:8px;height:8px;border-radius:50%}
.dot-ok{background:var(--ok)}
.dot-bad{background:var(--bad)}
.dot-warn{background:var(--warn)}
.dot-muted{background:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin-bottom:14px}
.hint{font-size:12px;color:var(--muted);margin-top:4px}
.error{background:rgba(248,81,73,.1);border:1px solid var(--bad);border-radius:6px;padding:12px 16px;color:var(--bad);font-size:13px;margin-bottom:16px;word-break:break-word}
.footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--border);font-size:11px;color:var(--muted)}
pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-family:var(--mono);font-size:12px;overflow-x:auto;margin:0;white-space:pre-wrap;word-break:break-word}
.hero{display:flex;align-items:baseline;gap:16px;margin-bottom:8px}
.hero .big{font-size:48px;font-weight:800;font-family:var(--mono);line-height:1;letter-spacing:-2px}
.hero .big.good{color:var(--ok)}
.hero .big.warn{color:var(--warn)}
.hero .big.bad{color:var(--bad)}
.hero .grade{font-size:15px;color:var(--muted)}
.pills{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.pill{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
.pill.crit{background:rgba(248,81,73,.15);color:#ff7b72}
.pill.warn{background:rgba(210,153,34,.15);color:#e3b341}
.pill.info{background:rgba(88,166,255,.15);color:#79c0ff}
.pill.pass{background:rgba(63,185,80,.15);color:#56d364}
.mod-row{display:grid;grid-template-columns:200px 60px 1fr 40px;gap:10px;align-items:center;padding:6px 0;font-size:13px}
.mod-row+.mod-row{border-top:1px solid var(--border)}
.mod-row .bar{height:8px;background:var(--panel-2);border-radius:4px;overflow:hidden}
.mod-row .bar>i{display:block;height:100%;border-radius:4px}
.mod-row .bar>i.good{background:var(--ok)}
.mod-row .bar>i.warn{background:var(--warn)}
.mod-row .bar>i.bad{background:var(--bad)}
.mod-row .w{color:var(--muted);font-size:12px}
.mod-row .s{font-family:var(--mono);font-weight:600;text-align:right}
.rec{border-left:3px solid var(--border);padding:10px 14px;margin-bottom:10px;background:var(--panel-2);border-radius:0 6px 6px 0}
.rec.crit{border-left-color:var(--bad)}
.rec.warn{border-left-color:var(--warn)}
.rec.info{border-left-color:var(--accent)}
.rec h4{margin:0 0 4px;font-size:14px;font-weight:600}
.rec .meta{font-size:11px;color:var(--muted);margin-bottom:4px}
.rec .fix{color:var(--ok);font-size:13px;margin-top:6px}
details summary{cursor:pointer;color:var(--muted);font-size:12px;padding:4px 0}
details[open] summary{color:var(--text);margin-bottom:6px}
</style>
</head>
<body>
<div class="wrap">
<h1>SEO-slicklab</h1>
<p class="muted" style="margin:0 0 14px">Technical, GEO &amp; Core Web Vitals audit — 10 engines, weighted scoring, ready-to-paste fixes.</p>

<form class="toolbar" method="post" action="" id="audit-form">
  <label for="url">URL to audit</label>
  <input type="url" id="url" name="url" value="<?= esc($url) ?>" placeholder="https://slicklab.digital/" required autofocus>
  <div class="row">
    <button type="submit" name="run_audit" value="1" class="btn" id="run-btn">Run audit</button>
    <button type="button" class="btn secondary" onclick="document.getElementById('url').value='https://slicklab.digital/';document.getElementById('url').focus();">slicklab.digital</button>
  </div>
  <p class="hint">Enter any public URL. Full report includes 10 engines.</p>
</form>

<script>
document.getElementById('audit-form')?.addEventListener('submit',function(){
  const b=document.getElementById('run-btn');
  if(b){b.disabled=true;b.textContent='Auditing…';}
});
</script>

<?php if ($error): ?>
<div class="error"><strong>Error:</strong> <?= esc($error) ?></div>
<?php endif; ?>

<?php if ($audit):
  $score    = (int)($audit['overall_score'] ?? 0);
  $grade    = (string)($audit['grade'] ?? '');
  $bucket   = score_bucket($score);
  $sum      = $audit['summary'] ?? [];
  $mods     = $audit['modules'] ?? [];
  $recs     = $audit['recommendations'] ?? [];
  $fixes    = $audit['fix_snippets'] ?? [];
  $timing   = $audit['fetch_timing'] ?? [];
  $status   = (int)($audit['http_status'] ?? 0);
  $finalUrl = (string)($audit['final_url'] ?? $url);
  $ttfb     = (int)($timing['ttfb_ms'] ?? 0);
  $domMs    = isset($timing['dom_load_ms']) ? (int)$timing['dom_load_ms'] : null;
  $headless = !empty($timing['headless_available']);
?>

<div class="status-bar">
  <div class="item"><span class="dot <?= ($status>=200 && $status<300)?'dot-ok':'dot-bad' ?>"></span> HTTP <?= $status ?></div>
  <div class="item"><span class="dot dot-ok"></span> <span class="mono"><?= esc($finalUrl) ?></span></div>
  <div class="item"><span class="dot <?= $ttfb<800?'dot-ok':'dot-warn' ?>"></span> TTFB <?= $ttfb ?> ms</div>
  <?php if ($headless && $domMs !== null): ?>
  <div class="item"><span class="dot <?= $domMs<3000?'dot-ok':'dot-warn' ?>"></span> DOM <?= $domMs ?> ms</div>
  <?php else: ?>
  <div class="item"><span class="dot dot-muted"></span> Headless skipped</div>
  <?php endif; ?>
  <div class="item"><span class="dot dot-muted"></span> <span class="mono">id <?= esc(substr((string)($audit['audit_id']??''),0,8)) ?></span></div>
</div>

<div class="panel">
  <div class="hero">
    <div class="big <?= $bucket ?>"><?= $score ?><span style="font-size:20px;color:var(--muted);font-weight:400;letter-spacing:0">/100</span></div>
    <div class="grade"><?= esc($grade) ?></div>
  </div>
  <div class="pills">
    <span class="pill crit"><?= (int)($sum['critical_errors']??0) ?> critical</span>
    <span class="pill warn"><?= (int)($sum['warnings']??0) ?> warnings</span>
    <span class="pill info"><?= (int)($sum['notices']??0) ?> notices</span>
    <span class="pill pass"><?= (int)($sum['passed_checks']??0) ?> passed</span>
  </div>
</div>

<?php if ($mods): ?>
<h2>Engine scores</h2>
<div class="panel">
<?php foreach ($mods as $key=>$m):
  if (($m['key']??$key)==='scoring_reporting') continue;
  $ms=(int)($m['score']??0); $mb=score_bucket($ms);
?>
  <div class="mod-row">
    <div><?= esc((string)($m['label']??$key)) ?></div>
    <div class="w"><?= (int)($m['weight']??0) ?>%</div>
    <div class="bar"><i class="<?= $mb ?>" style="width:<?= $ms ?>%"></i></div>
    <div class="s"><?= $ms ?></div>
  </div>
<?php endforeach; ?>
</div>
<?php endif; ?>

<?php if ($recs): ?>
<h2>Recommendations <span class="muted" style="font-weight:400;font-size:12px">(<?= count($recs) ?> total)</span></h2>
<div class="panel">
<?php foreach (array_slice($recs,0,25) as $r): $rc=sev_class((string)($r['severity']??'notice')); ?>
  <div class="rec <?= $rc ?>">
    <h4><?= esc((string)($r['title']??'')) ?></h4>
    <div class="meta"><?= esc((string)($r['module']??'')) ?> · <?= esc((string)($r['severity']??'')) ?> · impact <?= (int)($r['impact_score']??0) ?>/6</div>
    <div><?= esc((string)($r['description']??'')) ?></div>
    <?php if (!empty($r['action_item'])): ?>
    <div class="fix">→ <?= esc((string)$r['action_item']) ?></div>
    <?php endif; ?>
  </div>
<?php endforeach; ?>
<?php if (count($recs)>25): ?>
<p class="hint">…and <?= count($recs)-25 ?> more (see JSON below).</p>
<?php endif; ?>
</div>
<?php endif; ?>

<?php if ($fixes): ?>
<h2>Ready-to-paste fixes</h2>
<div class="panel">
<?php foreach ($fixes as $i=>$f): ?>
  <details <?= $i<3?'open':'' ?>>
    <summary><strong style="color:var(--text)"><?= esc((string)($f['target']??'')) ?></strong> — <span><?= esc((string)($f['reason']??'')) ?></span></summary>
    <pre><?= esc((string)($f['snippet']??'')) ?></pre>
  </details>
<?php endforeach; ?>
</div>
<?php endif; ?>

<h2>Raw audit JSON</h2>
<div class="panel"><details><summary>Show full JSON</summary><pre><?= esc(json_encode($audit, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)) ?></pre></details></div>

<?php endif; ?>

<div class="footer">SEO-slicklab v2.1.0 · 10-engine technical &amp; GEO audit · runs locally · no data leaves this server</div>
</div>
</body>
</html>