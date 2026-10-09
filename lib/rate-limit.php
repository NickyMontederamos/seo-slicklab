<?php
declare(strict_types=1);
/**
 * File-based limits for the public front end: each audit launches Chromium,
 * so cap audits per client IP and the number running at once.
 */

/** Sliding-window limiter. Returns false once $key has used $max hits in $windowSec. */
function rate_limit_allow(string $key, int $max, int $windowSec, string $dir): bool {
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        error_log("seo-slicklab: rate-limit dir not writable: $dir");
        return true;
    }
    $now = time();
    $fh = @fopen($dir . '/' . hash('sha256', $key) . '.json', 'c+');
    if (!$fh) {
        error_log("seo-slicklab: rate-limit file not writable in $dir");
        return true;
    }
    flock($fh, LOCK_EX);
    $hits = json_decode((string)stream_get_contents($fh), true);
    $hits = array_values(array_filter(is_array($hits) ? $hits : [],
        fn($t) => is_int($t) && $t > $now - $windowSec));
    $allowed = count($hits) < $max;
    if ($allowed) $hits[] = $now;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($hits));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);

    // Occasionally drop files for clients that have gone quiet.
    if (mt_rand(1, 100) === 1) {
        foreach (glob($dir . '/*.json') ?: [] as $f) {
            if (@filemtime($f) < $now - $windowSec) @unlink($f);
        }
    }
    return $allowed;
}

/**
 * Claims one of $slots concurrent-run slots. Returns the lock handle (keep it
 * open while the audit runs, then fclose it), true if locking is unavailable,
 * or null if all slots are busy.
 */
function rate_limit_acquire_slot(string $dir, int $slots) {
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $opened = false;
    for ($i = 0; $i < $slots; $i++) {
        $fh = @fopen("$dir/slot-$i.lock", 'c');
        if (!$fh) continue;
        $opened = true;
        if (flock($fh, LOCK_EX | LOCK_NB)) return $fh;
        fclose($fh);
    }
    if (!$opened) {
        error_log("seo-slicklab: slot lock files not writable in $dir");
        return true;
    }
    return null;
}
