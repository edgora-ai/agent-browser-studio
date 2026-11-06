(function (realm) {
  'use strict';
  const protocol = realm.AbsIdentityProtocol;
  if (realm.top !== realm) return;
  const status = realm.document.getElementById('status');
  const output = realm.document.getElementById('result');
  let sent = false;
  function publish(challenge, contexts) {
    if (sent) return;
    sent = true;
    const wire = protocol.serialize(challenge, contexts);
    output.textContent = wire;
    const report = JSON.parse(wire);
    status.textContent = report.complete ? '采集结束；不支持项见结果，非网络验收。' : '采集未完成；失败项见结果。';
    try {
      if (!realm.AbsProbe || typeof realm.AbsProbe.postMessage !== 'function') {
        status.textContent = '未连接原生接收器；结果仅在此显示。';
        return;
      }
      realm.AbsProbe.postMessage(wire);
    } catch (error) {
      status.textContent = '原生接收失败；结果仅在此显示。';
    }
  }
  function stop(challenge, code) {
    publish(challenge, protocol.KINDS.map((kind) => protocol.failed(kind, code)));
  }
  if (realm.location.origin !== protocol.APP_ORIGIN || realm.location.pathname !== protocol.BASE + 'index.html') {
    status.textContent = '地址不受支持；已停止采集。';
    return;
  }
  const challenge = protocol.challengeFromHash(realm.location.hash);
  if (!challenge) {
    stop(null, 'INVALID_CHALLENGE');
    return;
  }
  let bindings;
  try {
    bindings = protocol.KINDS.slice(1).map((kind) => ({ kind, challenge, requestId: protocol.requestId(realm) }));
    if (new Set(bindings.map((binding) => binding.requestId)).size !== bindings.length) throw new TypeError();
  } catch (error) {
    stop(challenge, 'REQUEST_ID_UNAVAILABLE');
    return;
  }
  status.textContent = '正在独立采集六种上下文，请稍候。';
  const jobs = [
    realm.AbsIdentityReadings.collect(realm, true).then((reading) => protocol.context('main', reading)),
    ...bindings.map((binding) => {
      if (binding.kind.endsWith('-frame')) return realm.AbsIdentityContexts.frame(realm, binding);
      if (binding.kind === 'service-worker') return realm.AbsIdentityServiceClient.run(realm, binding);
      return realm.AbsIdentityContexts.worker(realm, binding);
    })
  ];
  Promise.all(jobs.map((job, index) => Promise.resolve(job).catch(() =>
    protocol.failed(protocol.KINDS[index], 'INTERNAL_ERROR'))))
    .then((contexts) => publish(challenge, contexts))
    .catch(() => stop(challenge, 'INTERNAL_ERROR'));
})(globalThis);
