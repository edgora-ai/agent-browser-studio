(function (root) {
  'use strict';

  const APP_ORIGIN = 'https://appassets.androidplatform.net';
  const FRAME_ORIGIN = 'https://frames.abs-browser.invalid';
  const BASE = '/assets/identity-probe/';
  const KINDS = Object.freeze([
    'main', 'same-origin-frame', 'cross-origin-frame', 'dedicated-worker', 'shared-worker', 'service-worker'
  ]);
  const CODES = Object.freeze([
    'INVALID_CHALLENGE', 'INVALID_LOCATION', 'REQUEST_ID_UNAVAILABLE', 'API_UNSUPPORTED',
    'READ_FAILED', 'UA_DATA_FAILED', 'UA_DATA_TIMEOUT', 'CLOCK_FAILED', 'DEADLINE_EXCEEDED',
    'START_FAILED', 'CONTEXT_ERROR', 'MESSAGE_ERROR', 'MALFORMED_REPLY', 'CLEANUP_FAILED',
    'OUTPUT_TOO_LARGE', 'SW_REGISTER_FAILED', 'SW_ACTIVATION_FAILED', 'SW_UNREGISTER_FAILED',
    'SW_CLEANUP_UNCONFIRMED', 'INTERNAL_ERROR'
  ]);
  function safeChallenge(value) {
    return typeof value === 'string' && value.length <= 128 && !/[^a-fA-F0-9-]/.test(value) &&
      /^(?:[a-fA-F0-9]+|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(value);
  }
  function challengeFromHash(hash) {
    if (typeof hash !== 'string' || hash.length > 1024) return null;
    try {
      const params = new URLSearchParams(hash.replace(/^#/, ''));
      const values = params.getAll('challenge');
      return values.length === 1 && safeChallenge(values[0]) ? values[0] : null;
    } catch (error) {
      return null;
    }
  }
  function bindingFromParameters(parameters, kind) {
    try {
      if (typeof parameters !== 'string' || parameters.length > 1024 || !KINDS.slice(1).includes(kind)) return null;
      const params = new URLSearchParams(parameters.replace(/^[#?]/, ''));
      const keys = ['challenge', 'requestId', 'kind'];
      if (Array.from(params.keys()).length !== 3 || keys.some((key) => params.getAll(key).length !== 1)) return null;
      const challenge = params.get('challenge');
      const requestId = params.get('requestId');
      return safeChallenge(challenge) && typeof requestId === 'string' && requestId.length === 32 &&
        /^[a-f0-9]{32}$/.test(requestId) && params.get('kind') === kind
        ? { challenge, requestId, kind } : null;
    } catch (error) {
      return null;
    }
  }
  function requestId(realm) {
    const bytes = new Uint8Array(16);
    realm.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function parameters(binding) {
    return new URLSearchParams({ challenge: binding.challenge, requestId: binding.requestId, kind: binding.kind }).toString();
  }
  function resource(binding) {
    const files = {
      'same-origin-frame': 'frame.html', 'cross-origin-frame': 'frame.html',
      'dedicated-worker': 'dedicated-worker.js', 'shared-worker': 'shared-worker.js',
      'service-worker': 'service-worker.js'
    };
    const origin = binding.kind === 'cross-origin-frame' ? FRAME_ORIGIN : APP_ORIGIN;
    return origin + BASE + files[binding.kind] + (binding.kind === 'service-worker' ? '?' : '#') + parameters(binding);
  }
  function scope(binding) {
    return APP_ORIGIN + BASE + 'sw-scope/' + binding.requestId + '/';
  }
  function request(binding) {
    return { type: 'abs-identity:collect', schemaVersion: 1, ...binding };
  }
  function envelopeMatches(data, binding, type) {
    return !!data && typeof data === 'object' && data.type === type && data.schemaVersion === 1 &&
      data.challenge === binding.challenge && data.requestId === binding.requestId && data.kind === binding.kind;
  }
  function isRequest(data, binding) {
    return envelopeMatches(data, binding, 'abs-identity:collect') &&
      Object.keys(data).length === 5 && Object.keys(request(binding)).every((key) => Object.prototype.hasOwnProperty.call(data, key));
  }
  function failed(kind, code, values) {
    const result = { kind, status: 'failed', code: CODES.includes(code) ? code : 'INTERNAL_ERROR' };
    if (values !== undefined) result.values = values;
    return result;
  }
  function unsupported(kind) {
    return { kind, status: 'unsupported', code: 'API_UNSUPPORTED' };
  }
  function context(kind, reading) {
    return { kind, ...reading };
  }
  function validContext(result, kind) {
    if (!result || result.kind !== kind || !['ok', 'unsupported', 'failed'].includes(result.status)) return false;
    if (Object.keys(result).some((key) => !['kind', 'status', 'code', 'values'].includes(key))) return false;
    if (result.status === 'ok' ? result.code !== undefined : !CODES.includes(result.code)) return false;
    const windowRealm = ['main', 'same-origin-frame', 'cross-origin-frame'].includes(kind);
    if (result.values !== undefined && !root.AbsIdentityReadings.validValues(result.values, windowRealm)) return false;
    if (result.status === 'ok' && result.values && result.values.navigator.userAgentData &&
        result.values.navigator.userAgentData.highEntropy.status === 'failed') return false;
    return result.status !== 'ok' || result.values !== undefined;
  }
  function reply(binding, result, released) {
    const message = { type: 'abs-identity:result', schemaVersion: 1, ...binding, result };
    if (binding.kind === 'service-worker') message.released = released === true;
    return message;
  }
  function endpointMatches(event, endpoint) {
    if (endpoint.source !== undefined) return event.source === endpoint.source && event.origin === endpoint.origin;
    return event.currentTarget === endpoint.target && event.target === endpoint.target;
  }
  function resultFromReply(data, binding) {
    const keys = ['type', 'schemaVersion', 'challenge', 'requestId', 'kind', 'result'];
    if (binding.kind === 'service-worker') keys.push('released');
    if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(data, key)) ||
        !validContext(data.result, binding.kind)) return failed(binding.kind, 'MALFORMED_REPLY');
    if (binding.kind === 'service-worker' && data.released !== true) return failed(binding.kind, 'SW_UNREGISTER_FAILED');
    return data.result;
  }
  function byteLength(text) {
    let size = 0;
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit < 0x80) size += 1;
      else if (unit < 0x800) size += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length &&
          text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        size += 4;
        index += 1;
      } else size += 3;
    }
    return size;
  }
  function serialize(challenge, results) {
    const contexts = KINDS.map((kind) => {
      const matches = results.filter((result) => result && result.kind === kind);
      return matches.length === 1 && validContext(matches[0], kind)
        ? matches[0] : failed(kind, 'MALFORMED_REPLY');
    });
    const report = {
      schemaVersion: 1, challenge: safeChallenge(challenge) ? challenge : null,
      complete: safeChallenge(challenge) && contexts.every((result) => result.status !== 'failed'),
      contexts, coverage: { networkHeaders: false, proxyRouting: false, hardwareEmulation: false }
    };
    let wire = JSON.stringify(report);
    if (byteLength(wire) > 65536) {
      report.complete = false;
      report.contexts = KINDS.map((kind) => failed(kind, 'OUTPUT_TOO_LARGE'));
      wire = JSON.stringify(report);
    }
    return wire;
  }

  root.AbsIdentityProtocol = Object.freeze({
    APP_ORIGIN, FRAME_ORIGIN, BASE, KINDS, safeChallenge, challengeFromHash, bindingFromParameters,
    requestId, resource, scope, request, envelopeMatches, isRequest, failed, unsupported, context,
    reply, endpointMatches, resultFromReply, validContext, serialize, byteLength
  });
})(globalThis);
