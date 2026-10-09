<?php
declare(strict_types=1);
/**
 * SSRF guard for the public front end. Mirrors lib/url-guard.js — keep the
 * range and hostname lists identical (tests/fixtures/url-guard-cases.json is
 * run against both implementations).
 */

const URL_GUARD_BLOCKED_CIDRS = [
    // IPv4
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
    '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
    // IPv6
    '::/96', '::ffff:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/32',
    '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8',
];

const URL_GUARD_BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain', '.home.arpa'];

const URL_GUARD_NOT_ALLOWED_MSG =
    'URL not allowed: it points to a private, loopback, or reserved network address. '
    . 'SEO-slicklab only audits public websites.';

function url_guard_normalize_host(string $host): string {
    $h = strtolower(trim($host));
    if (str_starts_with($h, '[') && str_ends_with($h, ']')) $h = substr($h, 1, -1);
    $h = preg_replace('/%.*$/', '', $h) ?? $h;   // IPv6 zone id
    return rtrim($h, '.');
}

function url_guard_ip_in_cidr(string $ipBin, string $cidr): bool {
    [$net, $bits] = explode('/', $cidr);
    $netBin = inet_pton($net);
    if ($netBin === false || strlen($netBin) !== strlen($ipBin)) return false;
    $bits = (int)$bits;
    $whole = intdiv($bits, 8);
    if (strncmp($ipBin, $netBin, $whole) !== 0) return false;
    $rem = $bits % 8;
    if ($rem === 0) return true;
    $mask = (0xFF << (8 - $rem)) & 0xFF;
    return (ord($ipBin[$whole]) & $mask) === (ord($netBin[$whole]) & $mask);
}

/** True for any address in a blocked range. Non-IP input returns false. */
function url_guard_is_private_ip(string $ip): bool {
    $bin = @inet_pton(url_guard_normalize_host($ip));
    if ($bin === false) return false;
    foreach (URL_GUARD_BLOCKED_CIDRS as $cidr) {
        if (url_guard_ip_in_cidr($bin, $cidr)) return true;
    }
    return false;
}

/** Local-only names, plus single-label names that resolve via search domains. */
function url_guard_is_blocked_hostname(string $host): bool {
    $h = url_guard_normalize_host($host);
    if ($h === '') return true;
    if (@inet_pton($h) !== false) return false;
    if ($h === 'localhost' || !str_contains($h, '.')) return true;
    foreach (URL_GUARD_BLOCKED_SUFFIXES as $sfx) {
        if (str_ends_with($h, $sfx)) return true;
    }
    return false;
}

/** All A + AAAA addresses for $host (empty array if it does not resolve). */
function url_guard_resolve(string $host): array {
    $ips = @gethostbynamel($host) ?: [];
    $aaaa = @dns_get_record($host, DNS_AAAA);
    if (is_array($aaaa)) {
        foreach ($aaaa as $r) {
            if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
        }
    }
    return array_values(array_unique($ips));
}

/**
 * Returns an error message if $url must not be fetched, or null if it is safe.
 * $resolver (host => list of IPs) is injectable for tests.
 */
function url_guard_check(string $url, ?callable $resolver = null): ?string {
    $scheme = strtolower((string)parse_url($url, PHP_URL_SCHEME));
    if ($scheme !== 'http' && $scheme !== 'https') {
        return 'URL not allowed: only http:// and https:// URLs can be audited.';
    }
    $host = url_guard_normalize_host((string)parse_url($url, PHP_URL_HOST));
    if ($host === '') return 'URL not allowed: invalid URL.';

    if (@inet_pton($host) !== false) {
        return url_guard_is_private_ip($host) ? URL_GUARD_NOT_ALLOWED_MSG : null;
    }
    if (url_guard_is_blocked_hostname($host)) return URL_GUARD_NOT_ALLOWED_MSG;

    $ips = ($resolver ?? 'url_guard_resolve')($host);
    if (!$ips) return "URL not allowed: could not resolve host \"$host\".";
    foreach ($ips as $ip) {
        if (url_guard_is_private_ip((string)$ip)) return URL_GUARD_NOT_ALLOWED_MSG;
    }
    return null;
}
