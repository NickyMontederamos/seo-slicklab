'use strict';

const http = require('http');

/** Start a local site. routes: { '/path': { type, body, status } }, '*' = catch-all. */
function startSite(routes) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const r = routes[path] || routes['*'];
    if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(r.status || 200, { 'Content-Type': r.type || 'text/html; charset=utf-8' });
    res.end(r.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() });
    });
  });
}

const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(' ');

// "You": an empty SPA shell. Blocks GPTBot. /llms.txt falls through to index.html.
const SHELL = '<!doctype html><html><head><title>SlickLab</title></head>' +
  '<body><div id="root"></div><script src="/app.js"></script></body></html>';
const SPA_SITE = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' },
  '/app.js': { type: 'application/javascript',
    body: "document.getElementById('root').innerHTML='<h1>SlickLab Digital</h1><p>Software studio in Cebu City.</p>';" },
  '*': { body: SHELL }
};

// Strong rival: server-rendered content, schema, llms.txt, sitemap line.
const STRONG_SITE = {
  '/': { body: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strong Rival — Software Development in Cebu City</title>
<meta name="description" content="Custom web, mobile and AI software built in Cebu City for clients in the Philippines and abroad.">
<link rel="canonical" href="/">
<meta property="og:title" content="Strong Rival"><meta property="og:description" content="Software in Cebu">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Strong Rival","url":"https://strong.example/"}</script>
</head><body><header><nav><a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main><h1>Software Development in Cebu City</h1><h2>What we build</h2><p>${words(300)}</p>
<h2>FAQ</h2><p>Frequently asked questions. ${words(60)}</p></main><footer>Contact: hello@strong.example</footer></body></html>` },
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\nSitemap: https://strong.example/sitemap.xml\n' },
  '/llms.txt': { type: 'text/plain', body: '# Strong Rival\n\n> Software development in Cebu City.\n\n- [About](https://strong.example/about)\n' }
};

// Plain rival: real content, no schema, no robots.txt, no llms.txt.
const PLAIN_SITE = {
  '/': { body: `<!doctype html><html><head><title>Plain Rival</title></head>
<body><h1>Plain Rival Software</h1><p>${words(150)}</p></body></html>` }
};

module.exports = { startSite, SPA_SITE, STRONG_SITE, PLAIN_SITE };
