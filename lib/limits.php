<?php
declare(strict_types=1);

/**
 * Limits for the public audit page, so one visitor can't tie up the server.
 *
 *   rate_limit_take()  N audits per visitor per hour. Visitors are keyed by a salted
 *                      hash of their IP; nothing else is stored, and entries expire.
 *   audit_slot_take()  at most M audits running at once across all visitors.
 *
 * Both use plain files under the system temp dir (allowed by aaPanel's open_basedir).
 */

/**
 * First writable candidate: SLICKLAB_LIMITS_DIR, PHP's temp dir, then /tmp. PHP's temp dir can
 * point outside open_basedir on hosting panels, so it is never the only option.
 * Returns null when nothing is writable; the limits then let audits through and log why.
 */
function limits_dir(): ?string {
    static $dir = false;
    if ($dir !== false) return $dir;
    $candidates = array_filter([
        getenv('SLICKLAB_LIMITS_DIR') ?: null,
        rtrim(sys_get_temp_dir(), '/') . '/seo-slicklab-limits',
        '/tmp/seo-slicklab-limits',
    ]);
    foreach (array_unique($candidates) as $c) {
        if (!@is_dir($c)) @mkdir($c, 0700, true);
        if (@is_dir($c) && @is_writable($c)) return $dir = $c;
    }
    error_log('seo-slicklab limits: no writable directory (tried ' . implode(', ', $candidates) . '); limits are off');
    return $dir = null;
}

/** Salted so the stored key can't be reversed into an IP by guessing. The salt lives next to the data. */
function visitor_key(string $dir, string $ip): string {
    $saltFile = $dir . '/.salt';
    $salt = @file_get_contents($saltFile);
    if ($salt === false || strlen($salt) < 32) {
        $salt = bin2hex(random_bytes(32));
        @file_put_contents($saltFile, $salt, LOCK_EX);
        @chmod($saltFile, 0600);
    }
    return hash_hmac('sha256', $ip, $salt);
}

/**
 * Record one audit for this visitor if they are under the limit.
 * Returns [allowed, seconds until the next audit is allowed].
 */
function rate_limit_take(string $ip, int $max, int $window = 3600): array {
    $dir = limits_dir();
    if ($max <= 0 || $dir === null) return [true, 0];
    $file = $dir . '/rl-' . substr(visitor_key($dir, $ip), 0, 40);
    $fh = @fopen($file, 'c+');
    if (!$fh) return [true, 0]; // never lock people out because of a disk problem
    try {
        flock($fh, LOCK_EX);
        $now = time();
        $hits = array_values(array_filter(
            json_decode((string)stream_get_contents($fh), true) ?: [],
            fn($t) => is_int($t) && $t > $now - $window
        ));
        if (count($hits) >= $max) {
            sort($hits);
            return [false, max(1, $hits[0] + $window - $now)];
        }
        $hits[] = $now;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($hits));
        return [true, 0];
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

/** Delete rate-limit files nobody has touched for a while (called now and then). */
function rate_limit_gc(int $window = 3600): void {
    $dir = limits_dir();
    if ($dir === null) return;
    foreach (glob($dir . '/rl-*') ?: [] as $f) {
        if (@filemtime($f) < time() - $window) @unlink($f);
    }
}

/**
 * Claim one of $slots audit slots. Returns the open lock handle (keep it until the audit ends,
 * then pass it to audit_slot_release), true when the lock files can't be used at all (the audit
 * runs and the problem is logged), or null when every slot is genuinely busy.
 * The OS releases the lock if PHP dies mid-audit, so a crash can't leak a slot.
 */
function audit_slot_take(int $slots) {
    $dir = limits_dir();
    if ($dir === null) return true;
    $opened = 0;
    for ($i = 0; $i < max(1, $slots); $i++) {
        $fh = @fopen("$dir/slot-$i.lock", 'c');
        if (!$fh) continue;
        $opened++;
        if (flock($fh, LOCK_EX | LOCK_NB)) return $fh;
        fclose($fh);
    }
    if ($opened === 0) {
        error_log("seo-slicklab limits: cannot open lock files in $dir; running without the concurrency cap");
        return true;
    }
    return null;
}

function audit_slot_release($fh): void {
    if (is_resource($fh)) { flock($fh, LOCK_UN); fclose($fh); }
}
