'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { source, assetNames } = require('./helpers.cjs');

function policy(html) {
  const content = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(content, 'CSP meta is required');
  return new Map(content[1].split(';').map((part) => part.trim().split(/\s+/)).filter((parts) => parts[0])
    .map(([name, ...values]) => [name, values]));
}

test('pages declare restrictive local-resource CSP and no inline script/style or external assets', () => {
  const html = source('index.html');
  const frame = source('frame.html');
  for (const page of [html, frame]) {
    const csp = policy(page);
    for (const directive of ['default-src', 'connect-src', 'object-src', 'base-uri', 'form-action', 'img-src', 'font-src']) {
      assert.deepEqual(csp.get(directive), ["'none'"]);
    }
    assert.deepEqual(csp.get('script-src'), ["'self'"]);
    assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>|<style\b|\son[a-z]+\s*=/i);
    for (const match of page.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.match(match[1], /^[a-z-]+\.(?:js|css)$/);
      assert.ok(assetNames().includes(match[1]));
    }
  }
  const csp = policy(html);
  assert.deepEqual(csp.get('worker-src'), ["'self'"]);
  assert.deepEqual(csp.get('frame-src'), [
    'https://appassets.androidplatform.net/assets/identity-probe/frame.html',
    'https://frames.abs-browser.invalid/assets/identity-probe/frame.html'
  ]);
  assert.deepEqual(policy(frame).get('frame-src'), ["'none'"]);
  assert.deepEqual(policy(frame).get('worker-src'), ["'none'"]);
  assert.match(html, /仅内核身份自检，不代表Ping0或网络无泄漏/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
});

test('all assets are small raw sources; only main refers to the native bridge', () => {
  for (const name of assetNames()) {
    assert.match(name, /\.(?:js|css|html)$/);
    const code = source(name);
    if (!name.endsWith('.js')) continue;
    assert.ok(code.split('\n').length < 400, name + ' must stay under 400 lines');
    assert.doesNotMatch(code, /\.innerHTML\s*=|\b(?:eval|Function|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/);
    assert.doesNotMatch(code, /(?:navigator|Date|Window|Object)\.prototype(?:\.[a-zA-Z_$][\w$]*|\[[^\]]+\])?\s*=(?!=)|Object\.definePropert(?:y|ies)\s*\(/);
    if (name !== 'main.js') assert.doesNotMatch(code, /\.AbsProbe\b/);
  }
});

test('service worker code never enumerates registrations, claims clients, intercepts fetch or deletes stores', () => {
  for (const name of ['service-client.js', 'service-worker.js']) {
    const code = source(name).replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /getRegistrations|getRegistration\s*\(|\.ready\b|clients\.claim|skipWaiting|caches\.|indexedDB|localStorage|sessionStorage/);
    assert.doesNotMatch(code, /addEventListener\(['"]fetch/);
  }
});
