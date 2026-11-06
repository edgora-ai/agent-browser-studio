(function (root) {
  'use strict';
  const COOKIE = 'abs_storage_probe';
  const LOCAL = 'abs.storage-probe.v1';
  const DATABASE = 'abs_storage_probe_v1';
  const STORE = 'samples';
  const KEY = 'only';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function sample(value) {
    if (value === null || value === undefined) return { state: 'missing', value: null };
    return typeof value === 'string' && UUID.test(value)
      ? { state: 'present', value } : { state: 'invalid', value: null };
  }

  async function observed(action) {
    try { return sample(await action()); }
    catch (error) {
      return { state: error && error.message === 'IDB_READ_UNSUPPORTED' ? 'unsupported' : 'error', value: null };
    }
  }

  function cookieValue(document) {
    const text = document.cookie;
    if (typeof text !== 'string' || text.length > 4096) throw new Error('COOKIE_READ_FAILED');
    const values = text.split(';').map((part) => part.trim()).filter((part) => part.startsWith(COOKIE + '='));
    if (values.length > 1) return false;
    return values.length === 0 ? null : values[0].slice(COOKIE.length + 1);
  }

  async function read(source) {
    const values = await Promise.all([
      observed(() => cookieValue(source.document)),
      observed(() => source.localStorage.getItem(LOCAL)),
      observed(() => source.readDatabase())
    ]);
    return { cookie: values[0], localStorage: values[1], indexedDB: values[2] };
  }

  async function write(source, value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_SAMPLE');
    const writeErrors = [];
    for (const [name, action] of [
      ['cookie', () => { source.document.cookie = COOKIE + '=' + value + '; Max-Age=31536000; Path=/; Secure; SameSite=Strict'; }],
      ['localStorage', () => source.localStorage.setItem(LOCAL, value)],
      ['indexedDB', () => source.writeDatabase(value)]
    ]) {
      try { await action(); }
      catch (error) { writeErrors.push(name); }
    }
    return { stores: await read(source), writeErrors };
  }

  function databaseOperation(factory, value) {
    return new Promise((resolve, reject) => {
      let database;
      let transaction;
      let finished = false;
      const timer = setTimeout(() => {
        if (transaction) {
          try { transaction.abort(); }
          catch (error) { finish(new Error('IDB_TIMEOUT_ABORT_UNCONFIRMED')); return; }
        }
        finish(new Error('IDB_TIMEOUT'));
      }, 5000);
      function finish(error, result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (database) database.close();
        if (error) reject(error); else resolve(result);
      }
      let request;
      try { request = value === undefined ? factory.open(DATABASE) : factory.open(DATABASE, 1); }
      catch (error) { finish(new Error('IDB_OPEN_FAILED')); return; }
      request.onblocked = () => finish(new Error('IDB_BLOCKED'));
      request.onerror = () => finish(new Error('IDB_OPEN_FAILED'));
      request.onupgradeneeded = () => {
        database = request.result;
        if (finished || value === undefined) {
          request.transaction.abort();
          finish(new Error('IDB_MISSING_DURING_READ'));
          return;
        }
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        database = request.result;
        if (finished) { database.close(); return; }
        if (database.version !== 1 || !database.objectStoreNames.contains(STORE)) {
          finish(new Error('IDB_SCHEMA_MISMATCH'));
          return;
        }
        try {
          transaction = database.transaction(STORE, value === undefined ? 'readonly' : 'readwrite');
          let result;
          const object = transaction.objectStore(STORE);
          const operation = value === undefined ? object.get(KEY) : object.put(value, KEY);
          operation.onsuccess = () => { result = value === undefined ? operation.result : value; };
          transaction.oncomplete = () => finish(null, result === undefined ? null : result);
          transaction.onerror = () => finish(new Error('IDB_TRANSACTION_FAILED'));
          transaction.onabort = () => finish(new Error('IDB_TRANSACTION_ABORTED'));
        } catch (error) { finish(new Error('IDB_TRANSACTION_FAILED')); }
      };
    });
  }

  async function readDatabase(factory) {
    if (!factory || typeof factory.databases !== 'function') throw new Error('IDB_READ_UNSUPPORTED');
    let timer;
    const databases = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('IDB_ENUMERATION_TIMEOUT')), 5000);
      Promise.resolve(factory.databases()).then(resolve, reject);
    }).finally(() => clearTimeout(timer));
    if (!databases.some((item) => item.name === DATABASE)) return null;
    return databaseOperation(factory);
  }

  function createSample(crypto) {
    if (crypto && typeof crypto.randomUUID === 'function') {
      const value = crypto.randomUUID();
      if (!UUID.test(value)) throw new Error('INVALID_RANDOM_SAMPLE');
      return value;
    }
    if (!crypto || typeof crypto.getRandomValues !== 'function') throw new Error('SECURE_RANDOM_UNSUPPORTED');
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  root.AbsStorageSample = { read, write, readDatabase, createSample };
  if (!root.document) return;
  const document = root.document;
  const challenge = new URLSearchParams(root.location.hash.slice(1)).get('challenge');
  const result = document.getElementById('result');
  const status = document.getElementById('status');
  const writeButton = document.getElementById('write');
  const readButton = document.getElementById('read');
  if (!challenge || !UUID.test(challenge)) {
    status.textContent = '本地验证会话无效，未读取或写入样本。';
    writeButton.disabled = readButton.disabled = true;
    return;
  }
  const source = {
    document,
    get localStorage() { return root.localStorage; },
    readDatabase: () => readDatabase(root.indexedDB),
    writeDatabase: (value) => databaseOperation(root.indexedDB, value)
  };
  let busy = false;
  const writeSupported = root.crypto && (typeof root.crypto.randomUUID === 'function' || typeof root.crypto.getRandomValues === 'function');
  async function run(operation) {
    if (busy) return;
    if (operation === 'write' && !writeSupported) {
      status.textContent = '此 WebView 缺少安全随机数能力，无法写入样本；只读检查仍可用。';
      return;
    }
    busy = true;
    writeButton.disabled = readButton.disabled = true;
    status.textContent = operation === 'write' ? '正在写入合成样本并逐项读回。' : '正在只读检索原有样本；不会补写缺失值。';
    try {
      const expected = operation === 'write' ? createSample(root.crypto) : null;
      const observation = operation === 'write' ? await write(source, expected) : { stores: await read(source), writeErrors: [] };
      const report = { schemaVersion: 1, challenge, operation, expected, ...observation };
      result.textContent = JSON.stringify(report, null, 2);
      status.textContent = '观察已返回。请比较各存储原值；这不是完整持久性或登录态验收。';
      if (root.AbsStorageResult && typeof root.AbsStorageResult.postMessage === 'function') {
        root.AbsStorageResult.postMessage(JSON.stringify(report));
      } else {
        status.textContent = '原生结果通道不可用；不能确认本次观察已被应用接收。';
      }
    } catch (error) {
      status.textContent = '本次存储观察失败；没有用默认值替代结果。';
    } finally {
      busy = false;
      readButton.disabled = false;
      writeButton.disabled = !writeSupported;
      if (!writeSupported) status.textContent += ' 此 WebView 缺少安全随机数能力，写入不可用。';
    }
  }
  writeButton.addEventListener('click', () => run('write'));
  readButton.addEventListener('click', () => run('read'));
  run('read');
})(globalThis);
