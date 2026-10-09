'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isPrivateIp, assertPublicUrl } = require('../mcp/lib/url-guard.js');

test('private ranges are detected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('refuses private and non-http URLs', async () => {
  delete process.env.SLICKLAB_ALLOW_PRIVATE;
  await assert.rejects(assertPublicUrl('http://localhost:8080/'), /private/);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /private/);
  await assert.rejects(assertPublicUrl('ftp://example.com/'), /http/);
});
