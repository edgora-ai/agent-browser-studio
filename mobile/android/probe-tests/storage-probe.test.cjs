'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const asset = path.join(__dirname, '../app/src/main/assets/storage-probe/probe.js');
const A = 'b082b3f8-43d4-42dd-a63e-388f153d3e0b';
const B = 'b695e5fa-c2c7-4987-8015-9239e34c057e';
function api(timers = {}) {
  const context = vm.createContext({ setTimeout, clearTimeout, ...timers });
  vm.runInContext(fs.readFileSync(asset, 'utf8'), context, { filename: 'storage-probe/probe.js' });
  return context.AbsStorageSample;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function environment(initial = null) {
  const writes = [];
  let cookie = initial === null ? '' : 'abs_storage_probe=' + initial;
  let local = initial;
  let database = initial;
  const document = {
    get cookie() { return cookie; },
    set cookie(value) { writes.push(['cookie', value]); cookie = value.split(';')[0]; }
  };
  return {
    writes,
    source: {
      document,
      localStorage: {
        getItem(key) { assert.equal(key, 'abs.storage-probe.v1'); return local; },
        setItem(key, value) { assert.equal(key, 'abs.storage-probe.v1'); writes.push(['localStorage', value]); local = value; }
      },
      readDatabase: async () => database,
      writeDatabase: async (value) => { writes.push(['indexedDB', value]); database = value; }
    }
  };
}

test('initial cold read does not seed, clear or repair any store', async () => {
  const env = environment();
  const result = plain(await api().read(env.source));
  assert.deepEqual(env.writes, []);
  assert.deepEqual(result, {
    cookie: { state: 'missing', value: null },
    localStorage: { state: 'missing', value: null },
    indexedDB: { state: 'missing', value: null }
  });
});

test('explicit synthetic write reads the same marker from each actual adapter', async () => {
  const env = environment();
  const result = plain(await api().write(env.source, A));
  assert.equal(env.writes.length, 3);
  assert.deepEqual(result.writeErrors, []);
  for (const key of ['cookie', 'localStorage', 'indexedDB']) {
    assert.deepEqual(result.stores[key], { state: 'present', value: A });
  }
  assert.match(env.writes[0][1], /Max-Age=31536000; Path=\/; Secure; SameSite=Strict$/);
});

test('A and B data remain independent and re-reading A performs no write', async () => {
  const source = api();
  const first = environment();
  const second = environment();
  await source.write(first.source, A);
  assert.equal((await source.read(second.source)).cookie.state, 'missing');
  await source.write(second.source, B);
  const result = plain(await source.read(first.source));
  assert.equal(result.cookie.value, A);
  assert.equal(result.localStorage.value, A);
  assert.equal(result.indexedDB.value, A);
  assert.equal(first.writes.length, 3);
  assert.equal(second.writes.length, 3);
});

test('invalid persisted values are reported without reflecting arbitrary data', async () => {
  const env = environment('private-sentinel-not-a-synthetic-marker');
  const result = plain(await api().read(env.source));
  for (const key of ['cookie', 'localStorage', 'indexedDB']) {
    assert.deepEqual(result[key], { state: 'invalid', value: null });
  }
  assert.doesNotMatch(JSON.stringify(result), /private-sentinel/);
  assert.deepEqual(env.writes, []);
});

test('unrelated cookie names cannot satisfy the named sample', async () => {
  const env = environment();
  env.source.document = { cookie: 'other=' + A + '; abs_storage_probe_extra=' + A };
  assert.deepEqual(plain((await api().read(env.source)).cookie), { state: 'missing', value: null });
});

test('duplicate named cookies are ambiguous rather than a successful read', async () => {
  const env = environment();
  env.source.document = { cookie: 'abs_storage_probe=' + A + '; abs_storage_probe=' + B };
  assert.deepEqual(plain((await api().read(env.source)).cookie), { state: 'invalid', value: null });
});

test('storage read failures are explicit and do not disclose exception text', async () => {
  const env = environment();
  env.source.localStorage.getItem = () => { throw new Error('secret-error-sentinel'); };
  env.source.readDatabase = async () => { throw new Error('secret-database-sentinel'); };
  const result = plain(await api().read(env.source));
  assert.equal(result.localStorage.state, 'error');
  assert.equal(result.indexedDB.state, 'error');
  assert.doesNotMatch(JSON.stringify(result), /secret-/);
});

test('a rejected IDB write stays failed even when old data already matches', async () => {
  const env = environment(A);
  env.source.writeDatabase = async () => { throw new Error('synthetic-write-refusal'); };
  const result = plain(await api().write(env.source, A));
  assert.deepEqual(result.writeErrors, ['indexedDB']);
  assert.equal(result.stores.indexedDB.value, A);
});

test('arbitrary sample input is rejected before any storage mutation', async () => {
  const env = environment();
  await assert.rejects(api().write(env.source, 'not-a-synthetic-uuid'), /INVALID_SAMPLE/);
  assert.deepEqual(env.writes, []);
});

test('IDB cold reads inspect existing names without opening or creating a missing database', async () => {
  let opens = 0;
  const value = await api().readDatabase({
    databases: async () => [],
    open() { opens++; throw new Error('cold-read-must-not-create'); }
  });
  assert.equal(value, null);
  assert.equal(opens, 0);
});

test('unsupported IDB enumeration does not silently create a database on read', async () => {
  await assert.rejects(api().readDatabase({ open() { throw new Error('must-not-open'); } }), /IDB_READ_UNSUPPORTED/);
});

test('IDB enumeration is inside the deadline and cannot open after timing out', async () => {
  let expire;
  let release;
  let opens = 0;
  const source = api({ setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {} });
  const result = source.readDatabase({
    databases: () => new Promise((resolve) => { release = resolve; }),
    open() { opens++; throw new Error('must-not-open'); }
  });
  await Promise.resolve();
  assert.equal(typeof expire, 'function');
  const rejected = assert.rejects(result, /IDB_ENUMERATION_TIMEOUT/);
  expire();
  await rejected;
  release([{ name: 'abs_storage_probe_v1' }]);
  await Promise.resolve();
  assert.equal(opens, 0);
});

test('synthetic UUID generation uses secure random bytes when randomUUID is unavailable', () => {
  const value = api().createSample({ getRandomValues(bytes) { bytes.fill(0); return bytes; } });
  assert.equal(value, '00000000-0000-4000-8000-000000000000');
});

test('missing secure randomness is explicitly unsupported rather than using a fixed sample', () => {
  assert.throws(() => api().createSample({}), /SECURE_RANDOM_UNSUPPORTED/);
});
