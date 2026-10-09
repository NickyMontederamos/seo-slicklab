'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { startSite, SPA_SITE, STRONG_SITE, PLAIN_SITE } = require('./fixtures.js');

// Headless rendering runs only when a Chromium binary is pinned (CI / sandbox); otherwise raw-HTML mode.
const HEADLESS = Boolean(process.env.SLICKLAB_CHROMIUM_PATH);

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { ...process.env, ...env },
    stderr: 'ignore'
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}
const textOf = (res) => res.content.map((c) => c.text).join('\n');

test('MCP server end to end', { timeout: 240000 }, async (t) => {
  const [you, strong, plain] = await Promise.all([startSite(SPA_SITE), startSite(STRONG_SITE), startSite(PLAIN_SITE)]);
  const client = await connect({ SLICKLAB_ALLOW_PRIVATE: '1' });
  t.after(async () => { await client.close(); you.close(); strong.close(); plain.close(); });

  await t.test('lists the three tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['audit_site', 'check_ai_access', 'compare_rivals']);
  });

  await t.test('audit_site returns a summary', async () => {
    const res = await client.callTool({ name: 'audit_site', arguments: { url: strong.url, headless: HEADLESS, top: 5 } });
    assert.ok(!res.isError, textOf(res));
    assert.match(textOf(res), /Score \d+\/100/);
    assert.match(textOf(res), /\| AI \/ GEO Validator \|/);
  });

  await t.test('compare_rivals finds real gaps and no fake llms.txt lead', async () => {
    const res = await client.callTool({ name: 'compare_rivals', arguments: {
      your_url: you.url, your_label: 'SlickLab',
      rivals: [{ url: strong.url, label: 'Strong' }, { url: plain.url, label: 'Plain' }],
      headless: HEADLESS, limit: 50
    } });
    const md = textOf(res);
    assert.ok(!res.isError, md);
    assert.match(md, /# Rival gap report — SlickLab/);
    const gaps = md.split('## Open ground')[0];
    assert.match(gaps, /Strong/);
    assert.match(gaps, /schema|Schema|JSON-LD/);
    assert.match(md, /\| Engine \| You \| Strong \| Plain \|/);
    const lead = md.split('## Where you already lead')[1].split('## Engine scores')[0];
    assert.doesNotMatch(lead, /llms/, 'an HTML catch-all must not count as having llms.txt');
    if (HEADLESS) assert.match(gaps, /Headings available without JS/);
  });

  await t.test('check_ai_access reports per URL', async () => {
    const res = await client.callTool({ name: 'check_ai_access', arguments: { urls: [you.url, strong.url] } });
    const md = textOf(res);
    assert.match(md, /Content only appears after JavaScript runs/);
    assert.match(md, /\| GPTBot \| OpenAI \| training \| BLOCKED \|/);
  });
});

test('MCP server refuses private URLs by default', { timeout: 30000 }, async () => {
  const client = await connect({ SLICKLAB_ALLOW_PRIVATE: '0' });
  try {
    const res = await client.callTool({ name: 'audit_site', arguments: { url: 'http://127.0.0.1:9/', headless: false } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /private/);
  } finally { await client.close(); }
});
