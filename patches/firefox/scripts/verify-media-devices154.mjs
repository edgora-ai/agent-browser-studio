#!/usr/bin/env node
// Verify Firefox 154 native media device roster overrides.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_VERSION = "154.0";
const EXPECTED_SOURCE_STAMP = "9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc";
const REQUIRED_CAPABILITIES = [
  "config-v1", "native-required-v1", "snapshot-v1", "navigator-v1",
  "screen-v1", "canvas-v1", "webgl-v1", "webgpu-v1", "audio-v1",
  "geolocation-v1", "storage-quota-v1", "media-devices-v1",
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "media-devices-firefox-154.0.json");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : defaultOutput;
const force = process.argv.includes("--force");
const binary = process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH;
if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) {
  throw new Error("AGENT_BROWSER_FIREFOX_BINARY_PATH must point to the built Firefox executable");
}
if (!outputPath || outputPath === path.parse(outputPath).root) throw new Error("--output must name a JSON file");
if (fs.existsSync(outputPath) && !force) throw new Error(`Refusing to overwrite existing corpus without --force: ${outputPath}`);

const versionOutput = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const capabilities = JSON.parse(execFileSync(binary, ["--agent-browser-capabilities"], { encoding: "utf8" }));
if (!versionOutput.includes(EXPECTED_VERSION) || capabilities.product !== "agent-browser-firefox" ||
    capabilities.browserVersion !== EXPECTED_VERSION || capabilities.sourceStamp !== EXPECTED_SOURCE_STAMP ||
    !REQUIRED_CAPABILITIES.every((capability) => capabilities.capabilities?.includes(capability))) {
  throw new Error(`Unexpected Firefox build/capabilities: ${JSON.stringify({versionOutput,capabilities})}`);
}
const applicationIni = fs.readFileSync(
  path.resolve(path.dirname(binary), "..", "..", "Contents", "Resources", "application.ini"), "utf8");
if (applicationIni.match(/^SourceStamp=(.+)$/m)?.[1]?.trim() !== EXPECTED_SOURCE_STAMP) {
  throw new Error("Firefox application.ini SourceStamp mismatch");
}

const fingerprint = await import(pathToFileURL(path.join(repoRoot, "dist", "main", "services", "firefox-fingerprint.js")).href);
const identity = fingerprint.buildFirefoxManagedIdentity({
  fingerprintSeed: 154102, platform: "windows", locale: "en-US", timezone: "America/New_York",
}, EXPECTED_VERSION);
if (identity.config.mediaDevices?.enabled !== true ||
    identity.config.mediaDevices.audioInputs !== 1 ||
    identity.config.mediaDevices.videoInputs !== 1 ||
    identity.config.mediaDevices.audioOutputs !== 1) {
  throw new Error(`Unexpected product mediaDevices persona: ${JSON.stringify(identity.config.mediaDevices)}`);
}
const configMulti = structuredClone(identity.config);
configMulti.mediaDevices = { enabled: true, audioInputs: 2, videoInputs: 2, audioOutputs: 2 };
const configDisabled = structuredClone(identity.config);
configDisabled.mediaDevices = { enabled: false, audioInputs: 1, videoInputs: 1, audioOutputs: 1 };
const configZero = structuredClone(identity.config);
configZero.mediaDevices = { enabled: true, audioInputs: 0, videoInputs: 1, audioOutputs: 0 };

function encodedConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}
const invalidCases = [
  ["missing-media-devices", (config) => { delete config.mediaDevices; }],
  ["non-object-media-devices", (config) => { config.mediaDevices = "managed"; }],
  ["missing-enabled", (config) => { delete config.mediaDevices.enabled; }],
  ["string-enabled", (config) => { config.mediaDevices.enabled = "true"; }],
  ["missing-audio-inputs", (config) => { delete config.mediaDevices.audioInputs; }],
  ["negative-audio-inputs", (config) => { config.mediaDevices.audioInputs = -1; }],
  ["fractional-audio-inputs", (config) => { config.mediaDevices.audioInputs = 1.5; }],
  ["excessive-audio-inputs", (config) => { config.mediaDevices.audioInputs = 17; }],
  ["missing-video-inputs", (config) => { delete config.mediaDevices.videoInputs; }],
  ["string-video-inputs", (config) => { config.mediaDevices.videoInputs = "1"; }],
  ["null-audio-outputs", (config) => { config.mediaDevices.audioOutputs = null; }],
  ["excessive-audio-outputs", (config) => { config.mediaDevices.audioOutputs = 100; }],
];
for (const [label, mutate] of invalidCases) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-media154-invalid-${label}-`));
  try {
    const config = structuredClone(identity.config);
    mutate(config);
    fs.writeFileSync(path.join(profileDir, "user.js"),
      `user_pref("agent.browser.fingerprint.config", ${JSON.stringify(encodedConfig(config))});\n`,
      {encoding:"utf8",mode:0o600});
    const launch = spawnSync(binary, ["-profile",profileDir,"--headless","--agent-browser-native-required","--no-remote"],
      {encoding:"utf8",timeout:15000});
    const stderr = String(launch.stderr);
    if (launch.status === 0 || !stderr.includes("AGENT_BROWSER_NATIVE_CONFIG_ERROR: invalid-field:mediaDevices")) {
      throw new Error(`Invalid mediaDevices config did not fail closed (${label}): ${JSON.stringify({status:launch.status,signal:launch.signal,stderr:stderr.slice(-2000)})}`);
    }
  } finally {
    fs.rmSync(profileDir, {recursive:true,force:true});
  }
}
console.log(`Invalid mediaDevices configs rejected: ${invalidCases.length}/${invalidCases.length}`);

const bidi = await import(pathToFileURL(path.join(repoRoot, "dist", "main", "services", "bidi-client.js")).href);
const {connectBidi,bidiCreateContext,bidiCloseContext,bidiEvaluateInContext,bidiNavigate} = bidi;
function freePort() {
  return new Promise((resolve,reject) => {
    const server = net.createServer(); server.once("error",reject);
    server.listen(0,"127.0.0.1",() => { const address=server.address(); server.close(() => resolve(address.port)); });
  });
}
function listen(server) {
  return new Promise((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",() => resolve(server.address().port)); });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve,ms)); }

const expression = String.raw`(async function(){
  function methodEvidence(object,name){
    var proto=object;
    while(proto){
      var d=Object.getOwnPropertyDescriptor(proto,name);
      if(d&&typeof d.value==="function") return {source:Function.prototype.toString.call(d.value),name:d.value.name,length:d.value.length,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,owner:proto.constructor&&proto.constructor.name};
      proto=Object.getPrototypeOf(proto);
    }
    return null;
  }
  async function snapshot(scope){
    var devices=await scope.navigator.mediaDevices.enumerateDevices();
    var again=await scope.navigator.mediaDevices.enumerateDevices();
    return {
      devices:devices.map(function(d){return {kind:d.kind,label:d.label,deviceId:d.deviceId,groupId:d.groupId,json:JSON.stringify(d)};}),
      repeatIdentical:JSON.stringify(devices.map(function(d){return [d.kind,d.label,d.deviceId,d.groupId];}))===JSON.stringify(again.map(function(d){return [d.kind,d.label,d.deviceId,d.groupId];})),
      nativeEnumerate:methodEvidence(scope.navigator.mediaDevices,"enumerateDevices"),
    };
  }
  function frameSnapshot(allow){
    return new Promise(function(resolve){
      var frame=document.createElement("iframe");
      frame.src=location.origin+"/frame";
      if(allow!==null)frame.allow=allow;
      var timer=setTimeout(function(){frame.remove();resolve({error:"frame-timeout"});},15000);
      frame.onload=function(){
        frame.contentWindow.navigator.mediaDevices.enumerateDevices().then(function(devices){
          clearTimeout(timer);
          var value={devices:devices.map(function(d){return {kind:d.kind,label:d.label,deviceId:d.deviceId,groupId:d.groupId};}),nativeEnumerate:methodEvidence(frame.contentWindow.navigator.mediaDevices,"enumerateDevices")};
          frame.remove();resolve(value);
        },function(error){clearTimeout(timer);frame.remove();resolve({error:String(error)});});
      };
      document.body.appendChild(frame);
    });
  }
  function workerShape(shared){
    return new Promise(function(resolve){
      var source="postMessage({mediaDevices:typeof navigator.mediaDevices});self.close();";
      if(shared)source="self.onconnect=function(e){var p=e.ports[0];p.postMessage({mediaDevices:typeof navigator.mediaDevices});p.close();};";
      var url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));
      var timer=setTimeout(function(){URL.revokeObjectURL(url);resolve({error:"timeout"});},15000);
      if(shared){var worker=new SharedWorker(url);worker.port.onmessage=function(event){clearTimeout(timer);worker.port.close();URL.revokeObjectURL(url);resolve(event.data);};worker.port.start();}
      else{var worker=new Worker(url);worker.onmessage=function(event){clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};}
    });
  }
  var result={pre:await snapshot(window)};
  result.iframePre=await frameSnapshot(null);
  result.iframeDenied=await frameSnapshot("microphone 'none'; camera 'none'; speaker-selection 'none'");
  if(location.search.indexOf("grant=1")!==-1){
    var keepLive=location.search.indexOf("keeplive=1")!==-1;
    var stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});
    if(!keepLive)stream.getTracks().forEach(function(track){track.stop();});
    result.post=await snapshot(window);
    result.iframePost=await frameSnapshot(null);
    result.iframeDeniedPost=await frameSnapshot("microphone 'none'; camera 'none'; speaker-selection 'none'");
    result.iframeNoCameraPost=await frameSnapshot("camera 'none'");
    result.iframeNoSpeakerPost=await frameSnapshot("speaker-selection 'none'");
    if(keepLive)stream.getTracks().forEach(function(track){track.stop();});
  }
  result.dedicatedWorker=await workerShape(false);
  result.sharedWorker=await workerShape(true);
  return result;
})()`;

function makeServer() {
  const server=http.createServer((request,response)=>{response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 Media Devices Gate</title><body></body>");});
  return server;
}
const serverA=makeServer(),serverB=makeServer();
const portA=await listen(serverA),portB=await listen(serverB);
async function captureWorld(name,config,pagePort,grant=true,extraPrefs={},keepLive=false){
  const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),`agent-firefox-media154-${name}-`));
  const port=await freePort();let stderr="",child,connection,context;
  try{
    const prefs={
      ...(config?identity.nativePrefs:{}),
      "media.devices.unfocused_enabled":true,
      "media.navigator.streams.fake":true,
      "media.navigator.permission.disabled":true,
      ...extraPrefs,
      ...(config?{"agent.browser.fingerprint.config":encodedConfig(config)}:{}),
    };
    const userJs=Object.entries(prefs).sort(([a],[b])=>a.localeCompare(b)).map(([pref,value])=>`user_pref(${JSON.stringify(pref)}, ${JSON.stringify(value)});`).join("\n");
    fs.writeFileSync(path.join(profileDir,"user.js"),`${userJs}\n`,{encoding:"utf8",mode:0o600});
    child=spawn(binary,["-profile",profileDir,`--remote-debugging-port=${port}`,"--headless",...(config?["--agent-browser-native-required"]:[]),"--no-remote"],{env:{...process.env,TZ:config?.timezone||process.env.TZ},stdio:["ignore","ignore","pipe"]});
    child.stderr.on("data",(data)=>{stderr+=String(data);});
    for(let attempt=0;attempt<80;attempt++){
      if(child.exitCode!==null)throw new Error(`${name} exited early (${child.exitCode}): ${stderr.slice(-2000)}`);
      try{connection=await connectBidi(`ws://127.0.0.1:${port}/session`,{timeoutMs:2000});break;}catch(error){await sleep(250);}
    }
    if(!connection)throw new Error(`${name} did not expose BiDi: ${stderr.slice(-2000)}`);
    context=await bidiCreateContext(connection,15000);await bidiNavigate(connection,`http://127.0.0.1:${pagePort}/?grant=${grant?"1":"0"}&keeplive=${keepLive?"1":"0"}`,context,15000);
    return await bidiEvaluateInContext(connection,expression,context,120000);
  }finally{
    if(context&&connection){try{await bidiCloseContext(connection,context,8000);}catch(error){console.error(String(error));}}
    if(connection)connection.close();
    if(child){child.kill("SIGTERM");await Promise.race([new Promise((resolve)=>child.once("exit",resolve)),sleep(10000).then(()=>{if(child.exitCode===null)child.kill("SIGKILL");})]);}
    fs.rmSync(profileDir,{recursive:true,force:true});
  }
}
function assertNativeEnumerate(record,label){
  const evidence=record?.nativeEnumerate;
  if(!evidence?.source?.includes("[native code]")||evidence.owner!=="MediaDevices"||evidence.writable!==true||evidence.enumerable!==true||evidence.configurable!==true){
    throw new Error(`${label} enumerateDevices descriptor non-native: ${JSON.stringify(evidence)}`);
  }
}
function rosterKey(record){return record.devices.map((device)=>device.kind).join(",");}
function assertEmptyFields(record,label){
  for(const device of record.devices){
    if(device.label!==""||device.deviceId!==""||device.groupId!==""){
      throw new Error(`${label} leaked device info before permission: ${JSON.stringify(device)}`);
    }
  }
}
const MIC_LABEL="Default - 'default'",CAM_LABEL="FaceTime HD Camera (Built-in)";
function assertManagedPost(world,label,count){
  const devices=world.post.devices;
  if(devices.length!==count*3)throw new Error(`${label} post-permission roster size: ${JSON.stringify(world.post)}`);
  for(let index=0;index<count;index++){
    const mic=devices[index],cam=devices[count+index],speaker=devices[2*count+index];
    const micLabel=index===0?MIC_LABEL:`Microphone (${index+1})`;
    const camLabel=index===0?CAM_LABEL:`Camera (${index+1})`;
    const speakerLabel=index===0?MIC_LABEL:`Speaker (${index+1})`;
    if(mic.kind!=="audioinput"||mic.label!==micLabel)throw new Error(`${label} mic ${index} mismatch: ${JSON.stringify(mic)}`);
    if(cam.kind!=="videoinput"||cam.label!==camLabel)throw new Error(`${label} cam ${index} mismatch: ${JSON.stringify(cam)}`);
    if(speaker.kind!=="audiooutput"||speaker.label!==speakerLabel)throw new Error(`${label} speaker ${index} mismatch: ${JSON.stringify(speaker)}`);
    for(const [deviceLabel,device] of [["mic",mic],["cam",cam],["speaker",speaker]]){
      if(device.deviceId.length<40||device.groupId.length<40){
        throw new Error(`${label} ${deviceLabel} ids not anonymized: ${JSON.stringify(device)}`);
      }
    }
    if(mic.groupId!==speaker.groupId||mic.groupId===cam.groupId){
      throw new Error(`${label} group coherence failed: ${JSON.stringify({mic,cam,speaker})}`);
    }
  }
}

try{
  const managedA=await captureWorld("managed-a",identity.config,portA,true);
  const managedB=await captureWorld("managed-b",identity.config,portA,true);
  const managedOtherOrigin=await captureWorld("managed-origin-b",identity.config,portB,true);
  const multi=await captureWorld("multi",configMulti,portA,true);
  const disabled=await captureWorld("disabled",configDisabled,portA,true);
  const stock=await captureWorld("stock",null,portA,true);
  const zero=await captureWorld("zero",configZero,portA,true);
  const legacyNoGrant=await captureWorld("legacy-nogrant",identity.config,portA,false,{"media.devices.enumerate.legacy.enabled":true});
  const legacyNoGrantStock=await captureWorld("legacy-nogrant-stock",null,portA,false,{"media.devices.enumerate.legacy.enabled":true});
  const legacyGrant=await captureWorld("legacy-grant",identity.config,portA,true,{"media.devices.enumerate.legacy.enabled":true},true);
  const legacyGrantStock=await captureWorld("legacy-grant-stock",null,portA,true,{"media.devices.enumerate.legacy.enabled":true},true);
  const noSinkid=await captureWorld("no-sinkid",identity.config,portA,true,{"media.setsinkid.enabled":false});
  const noSinkidStock=await captureWorld("no-sinkid-stock",null,portA,true,{"media.setsinkid.enabled":false});
  const rfpManaged=await captureWorld("rfp-managed",identity.config,portA,true,{"privacy.resistFingerprinting":true});
  const rfpStock=await captureWorld("rfp-stock",null,portA,true,{"privacy.resistFingerprinting":true});
  for(const [label,world] of [["managedA",managedA],["managedB",managedB],["multi",multi],["disabled",disabled],["stock",stock],["zero",zero],["legacyNoGrant",legacyNoGrant],["legacyNoGrantStock",legacyNoGrantStock],["legacyGrant",legacyGrant],["legacyGrantStock",legacyGrantStock],["noSinkid",noSinkid],["noSinkidStock",noSinkidStock],["rfpManaged",rfpManaged],["rfpStock",rfpStock]]){
    assertNativeEnumerate(world.pre,`${label}.pre`);
    assertNativeEnumerate(world.iframePre,`${label}.iframePre`);
    if(world.post)assertNativeEnumerate(world.post,`${label}.post`);
    for(const [workerLabel,worker] of [["dedicated",world.dedicatedWorker],["shared",world.sharedWorker]]){
      if(worker?.mediaDevices!=="undefined"){
        throw new Error(`${label}.${workerLabel} Worker mediaDevices exposure changed: ${JSON.stringify(worker)}`);
      }
    }
  }
  // Pre-permission roster shape: one device per kind (stock first-device cap),
  // all fields empty.
  if(rosterKey(managedA.pre)!=="audioinput,videoinput"||rosterKey(managedA.iframePre)!=="audioinput,videoinput"){
    throw new Error(`managed pre-permission roster wrong: ${JSON.stringify({window:managedA.pre,iframe:managedA.iframePre})}`);
  }
  assertEmptyFields(managedA.pre,"managedA.pre");assertEmptyFields(managedA.iframePre,"managedA.iframePre");
  if(rosterKey(multi.pre)!=="audioinput,videoinput"){
    throw new Error(`multi pre-permission roster wrong (stock caps at one per kind before permission): ${JSON.stringify(multi.pre)}`);
  }
  assertEmptyFields(multi.pre,"multi.pre");
  if(rosterKey(zero.pre)!=="videoinput"||rosterKey(zero.post)!=="videoinput"){
    throw new Error(`zero-count roster wrong: ${JSON.stringify({pre:zero.pre,post:zero.post})}`);
  }
  assertEmptyFields(zero.pre,"zero.pre");
  if(JSON.stringify(disabled.pre)!==JSON.stringify(stock.pre)){
    throw new Error(`disabled mediaDevices diverged from stock pre-permission: ${JSON.stringify({disabled:disabled.pre,stock:stock.pre})}`);
  }
  // Permissions-Policy denial must drop the whole persona roster.
  if(!managedA.iframeDenied||managedA.iframeDenied.devices?.length!==0){
    throw new Error(`managed denied-policy iframe roster not empty: ${JSON.stringify(managedA.iframeDenied)}`);
  }
  if(!multi.iframeDenied||multi.iframeDenied.devices?.length!==0){
    throw new Error(`multi denied-policy iframe roster not empty: ${JSON.stringify(multi.iframeDenied)}`);
  }
  if(JSON.stringify(disabled.iframeDenied)!==JSON.stringify(stock.iframeDenied)){
    throw new Error(`disabled denied-policy iframe diverged from stock: ${JSON.stringify({disabled:disabled.iframeDenied,stock:stock.iframeDenied})}`);
  }
  // Post-permission persona roster.
  assertManagedPost(managedA,"managedA",1);
  assertManagedPost(managedB,"managedB",1);
  assertManagedPost(multi,"multi",2);
  if(!managedA.post.repeatIdentical||!multi.post.repeatIdentical){
    throw new Error("managed roster not stable across repeated enumerateDevices calls");
  }
  if(JSON.stringify(managedA.post.devices)!==JSON.stringify(managedB.post.devices)){
    throw new Error(`managed roster changed across restarts: ${JSON.stringify({a:managedA.post.devices,b:managedB.post.devices})}`);
  }
  if(JSON.stringify(managedA.post.devices)===JSON.stringify(managedOtherOrigin.post.devices)){
    throw new Error("managed roster ids correlate across origins");
  }
  if(managedA.post.devices[0].label!==managedOtherOrigin.post.devices[0].label){
    throw new Error("managed roster labels differ across origins");
  }
  if(managedA.iframeDeniedPost?.devices?.length!==0){
    throw new Error(`managed denied-policy iframe post-permission roster not empty: ${JSON.stringify(managedA.iframeDeniedPost)}`);
  }
  const shapeOf=(record)=>record.devices.map((device)=>({kind:device.kind,label:device.label}));
  if(JSON.stringify(shapeOf(disabled.post))!==JSON.stringify(shapeOf(stock.post))){
    throw new Error(`disabled mediaDevices diverged from stock post-permission: ${JSON.stringify({disabled:shapeOf(disabled.post),stock:shapeOf(stock.post)})}`);
  }
  if(JSON.stringify(managedA.post.devices)===JSON.stringify(stock.post.devices)){
    throw new Error("managed persona roster identical to stock roster");
  }
  // Decomposed Permissions-Policy: denying one kind drops only that kind.
  // Same-origin iframes have no capture of their own, so speakers stay hidden
  // in both cases (stock per-window speaker exposure rule).
  if(rosterKey(managedA.iframeNoCameraPost)!=="audioinput"){
    throw new Error(`camera-denied iframe roster wrong: ${JSON.stringify(managedA.iframeNoCameraPost)}`);
  }
  assertEmptyFields(managedA.iframeNoCameraPost,"managedA.iframeNoCameraPost");
  if(rosterKey(managedA.iframeNoSpeakerPost)!=="audioinput,videoinput"){
    throw new Error(`speaker-denied iframe roster wrong: ${JSON.stringify(managedA.iframeNoSpeakerPost)}`);
  }
  assertEmptyFields(managedA.iframeNoSpeakerPost,"managedA.iframeNoSpeakerPost");
  // Legacy enumeration: ids exposed without capture, labels hidden until
  // capture is permitted; speakers stay hidden without an explicit grant.
  // Label visibility must mirror the stock legacy worlds exactly.
  if(rosterKey(legacyNoGrant.pre)!=="audioinput,videoinput"){
    throw new Error(`legacy pre-permission roster wrong: ${JSON.stringify(legacyNoGrant.pre)}`);
  }
  const stockNoGrantLabelVisible={};
  for(const device of legacyNoGrantStock.pre.devices){
    if(device.label!=="")stockNoGrantLabelVisible[device.kind]=true;
  }
  for(const device of legacyNoGrant.pre.devices){
    if(device.deviceId.length<40)throw new Error(`legacy hid anonymized id: ${JSON.stringify(device)}`);
    if(!stockNoGrantLabelVisible[device.kind]&&device.label!==""){
      throw new Error(`legacy leaked label before capture that stock hides: ${JSON.stringify({managed:device,stock:legacyNoGrantStock.pre.devices})}`);
    }
  }
  if(rosterKey(legacyNoGrantStock.pre).includes("audiooutput")){
    throw new Error(`stock legacy pre-permission unexpectedly exposed speakers: ${JSON.stringify(legacyNoGrantStock.pre)}`);
  }
  if(rosterKey(legacyGrant.post)!=="audioinput,videoinput,audiooutput"){
    throw new Error(`legacy live-capture roster wrong: ${JSON.stringify(legacyGrant.post)}`);
  }
  const stockLabelVisible={};
  for(const device of legacyGrantStock.post.devices){
    if(device.label!=="")stockLabelVisible[device.kind]=true;
  }
  for(let index=0;index<legacyGrant.post.devices.length;index++){
    const managed=legacyGrant.post.devices[index];
    if(managed.deviceId.length<40)throw new Error(`legacy live-capture id not anonymized: ${JSON.stringify(managed)}`);
    if(!stockLabelVisible[managed.kind]){
      if(managed.label!=="")throw new Error(`legacy leaked label stock hides: ${JSON.stringify({managed,stock:legacyGrantStock.post.devices})}`);
    }else{
      const expected=managed.kind==="videoinput"?CAM_LABEL:MIC_LABEL;
      if(managed.label!==expected)throw new Error(`legacy persona label wrong: ${JSON.stringify({managed,stock:legacyGrantStock.post.devices})}`);
    }
  }
  if(JSON.stringify(legacyGrant.post.devices.map((device)=>device.deviceId))===
     JSON.stringify(legacyGrantStock.post.devices.map((device)=>device.deviceId))){
    throw new Error("legacy persona ids identical to stock roster");
  }
  // media.setsinkid.enabled=false drops speakers for managed and stock alike.
  if(rosterKey(noSinkid.post)!=="audioinput,videoinput"||rosterKey(noSinkidStock.post).includes("audiooutput")){
    throw new Error(`setsinkid-disabled roster wrong: ${JSON.stringify({managed:rosterKey(noSinkid.post),stock:rosterKey(noSinkidStock.post)})}`);
  }
  // RFP windows take the stock RFP path: no persona labels, shape equal to
  // stock RFP worlds.
  const rfpShape=(record)=>record.devices.map((device)=>({kind:device.kind,label:device.label}));
  if(JSON.stringify(rfpShape(rfpManaged.pre))!==JSON.stringify(rfpShape(rfpStock.pre))||
     JSON.stringify(rfpShape(rfpManaged.post))!==JSON.stringify(rfpShape(rfpStock.post))){
    throw new Error(`RFP pass-through diverged: ${JSON.stringify({managed:rfpShape(rfpManaged.post),stock:rfpShape(rfpStock.post)})}`);
  }
  for(const device of rfpManaged.post.devices){
    if(device.label===MIC_LABEL||device.label===CAM_LABEL||device.label.startsWith("Speaker (")){
      throw new Error(`RFP window leaked persona roster: ${JSON.stringify(device)}`);
    }
  }
  const result={schemaVersion:1,browser:{engine:"firefox",version:EXPECTED_VERSION,sourceStamp:EXPECTED_SOURCE_STAMP,versionOutput,platform:"macos-arm64",branding:"unofficial"},capture:{mode:"webdriver-bidi-headless-native-media-devices",fingerprintConfig:identity.config,preloadScript:false,nativeRequired:true},capabilities,evidence:{managed:managedA,denied:null,disabled,stock,multi,zero,legacy:{noGrant:legacyNoGrant,noGrantStock:legacyNoGrantStock,grant:legacyGrant,grantStock:legacyGrantStock},noSinkid:{managed:noSinkid,stock:noSinkidStock},rfp:{managed:rfpManaged,stock:rfpStock},crossOrigin:{sameOriginRestart:managedB,otherOrigin:managedOtherOrigin}}};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});const staging=`${outputPath}.staging-${process.pid}`;
  if(fs.existsSync(staging))throw new Error(`media devices corpus staging path already exists: ${staging}`);
  fs.writeFileSync(staging,`${JSON.stringify(result,null,2)}\n`,"utf8");fs.renameSync(staging,outputPath);
  const text=fs.readFileSync(outputPath,"utf8"),readback=JSON.parse(text);
  if(readback.browser?.sourceStamp!==EXPECTED_SOURCE_STAMP||readback.capabilities?.sourceStamp!==EXPECTED_SOURCE_STAMP||
     !readback.capabilities?.capabilities?.includes("media-devices-v1")||
     readback.capture?.preloadScript!==false||readback.capture?.nativeRequired!==true||
     readback.evidence?.managed?.post?.devices?.length!==3||
     !text.includes('"crossOrigin"'))throw new Error("media devices corpus readback/search validation failed");
  console.log(`Firefox media devices corpus written: ${outputPath}`);
  console.log(`Managed roster: ${JSON.stringify(readback.evidence.managed.post.devices.map((device)=>({kind:device.kind,label:device.label})))}`);
  console.log(`Stock roster: ${JSON.stringify(readback.evidence.stock.post.devices.map((device)=>({kind:device.kind,label:device.label})))}`);
}finally{
  await new Promise((resolve)=>serverA.close(resolve));
  await new Promise((resolve)=>serverB.close(resolve));
}
