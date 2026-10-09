<?php
declare(strict_types=1);
// Run: php tests/url-guard.test.php   (exit 0 = pass)

require __DIR__ . '/../lib/url-guard.php';
require __DIR__ . '/../lib/rate-limit.php';

$cases = json_decode((string)file_get_contents(__DIR__ . '/fixtures/url-guard-cases.json'), true);
$failures = [];
$assert = function (bool $ok, string $msg) use (&$failures): void {
    if (!$ok) $failures[] = $msg;
};

foreach ($cases['blockedIps'] as $ip) $assert(url_guard_is_private_ip($ip), "should block IP $ip");
foreach ($cases['allowedIps'] as $ip) $assert(!url_guard_is_private_ip($ip), "should allow IP $ip");
foreach ($cases['blockedHosts'] as $h) $assert(url_guard_is_blocked_hostname($h), "should block host '$h'");
foreach ($cases['allowedHosts'] as $h) $assert(!url_guard_is_blocked_hostname($h), "should allow host '$h'");

$noDns = function (string $host): array { throw new RuntimeException("unexpected DNS lookup: $host"); };
foreach ($cases['urls']['blocked'] as $u) $assert(url_guard_check($u, $noDns) !== null, "should block URL $u");
foreach ($cases['urls']['allowed'] as $u) $assert(url_guard_check($u, $noDns) === null, "should allow URL $u");

$table = [
    'good.example'  => ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'evil.example'  => ['127.0.0.1'],
    'mixed.example' => ['8.8.8.8', '::1'],
    'meta.example'  => ['169.254.169.254'],
];
$resolver = fn(string $h): array => $table[$h] ?? [];
$assert(url_guard_check('https://good.example/page', $resolver) === null, 'should allow good.example');
foreach (['evil.example', 'mixed.example', 'meta.example'] as $h) {
    $assert(url_guard_check("https://$h/", $resolver) === URL_GUARD_NOT_ALLOWED_MSG, "should block $h");
}
$assert(str_contains((string)url_guard_check('https://nx.example/', $resolver), 'could not resolve'),
    'unresolvable host should be refused');

// Real resolver: localhost-style names never reach DNS, IP literals are checked directly.
$assert(url_guard_check('http://127.0.0.1/') === URL_GUARD_NOT_ALLOWED_MSG, 'real check: 127.0.0.1');
$assert(url_guard_check('http://169.254.169.254/latest/meta-data/') === URL_GUARD_NOT_ALLOWED_MSG, 'real check: metadata');

// Rate limiter: 3 per window, then refused; other keys unaffected.
$dir = sys_get_temp_dir() . '/seo-slicklab-rl-test-' . bin2hex(random_bytes(4));
for ($i = 1; $i <= 3; $i++) $assert(rate_limit_allow('203.0.113.5', 3, 60, $dir), "hit $i should pass");
$assert(!rate_limit_allow('203.0.113.5', 3, 60, $dir), 'hit 4 should be limited');
$assert(rate_limit_allow('198.51.100.9', 3, 60, $dir), 'other IP should pass');

// Concurrency slots: 2 slots, third caller is refused until one is released.
$a = rate_limit_acquire_slot($dir, 2);
$b = rate_limit_acquire_slot($dir, 2);
$assert(is_resource($a) && is_resource($b), 'two slots available');
$assert(rate_limit_acquire_slot($dir, 2) === null, 'third slot refused');
fclose($a);
$c = rate_limit_acquire_slot($dir, 2);
$assert(is_resource($c), 'slot free again after release');
fclose($b);
fclose($c);
array_map('unlink', glob("$dir/*") ?: []);
@rmdir($dir);

if ($failures) {
    fwrite(STDERR, "FAIL\n  " . implode("\n  ", $failures) . "\n");
    exit(1);
}
echo "url-guard.test.php: all checks passed\n";
