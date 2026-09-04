#!/usr/bin/env node
// Verify Firefox 154 native permission-preserving geolocation and storage quota.
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
  "geolocation-v1", "storage-quota-v1",
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "geo-storage-firefox-154.0.json");
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
const configCustom = structuredClone(identity.config);
configCustom.geolocation = { mode: "custom", latitude: 37.7749, longitude: -122.4194, accuracy: 17.5 };
const configDisable = structuredClone(configCustom);
configDisable.geolocation = { mode: "disable", latitude: null, longitude: null, accuracy: null };
const configReal = structuredClone(configCustom);
configReal.geolocation = { mode: "real", latitude: null, longitude: null, accuracy: null };
const configLowQuota = structuredClone(configCustom);
configLowQuota.storageQuotaBytes = 1;

function encodedConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}
const invalidCases = [
  ["missing-geolocation", "invalid-field:geolocation", (config) => { delete config.geolocation; }],
  ["non-object-geolocation", "invalid-field:geolocation", (config) => { config.geolocation = "custom"; }],
  ["missing-mode", "invalid-field:geolocation", (config) => { delete config.geolocation.mode; }],
  ["invalid-mode", "invalid-field:geolocation", (config) => { config.geolocation.mode = "fixed"; }],
  ["real-with-coordinates", "incoherent-geolocation", (config) => { config.geolocation.mode = "real"; }],
  ["custom-missing-latitude", "incoherent-geolocation", (config) => { config.geolocation.latitude = null; }],
  ["custom-latitude-range", "invalid-field:geolocation", (config) => { config.geolocation.latitude = 91; }],
  ["custom-longitude-range", "invalid-field:geolocation", (config) => { config.geolocation.longitude = -181; }],
  ["custom-zero-accuracy", "incoherent-geolocation", (config) => { config.geolocation.accuracy = 0; }],
  ["custom-string-accuracy", "invalid-field:geolocation", (config) => { config.geolocation.accuracy = "17"; }],
  ["missing-storage-quota", "invalid-field:storageQuotaBytes", (config) => { delete config.storageQuotaBytes; }],
  ["null-storage-quota", "invalid-field:storageQuotaBytes", (config) => { config.storageQuotaBytes = null; }],
  ["string-storage-quota", "invalid-field:storageQuotaBytes", (config) => { config.storageQuotaBytes = "1000"; }],
  ["zero-storage-quota", "invalid-field:storageQuotaBytes", (config) => { config.storageQuotaBytes = 0; }],
  ["fractional-storage-quota", "invalid-field:storageQuotaBytes", (config) => { config.storageQuotaBytes = 1.5; }],
  ["unsafe-storage-quota", "invalid-field:storageQuotaBytes", (config) => { config.storageQuotaBytes = 9007199254740992; }],
];
for (const [label, expectedError, mutate] of invalidCases) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-geo-storage154-invalid-${label}-`));
  try {
    const config = structuredClone(configCustom);
    mutate(config);
    fs.writeFileSync(path.join(profileDir, "user.js"),
      `user_pref("agent.browser.fingerprint.config", ${JSON.stringify(encodedConfig(config))});\n`,
      {encoding:"utf8",mode:0o600});
    const launch = spawnSync(binary, ["-profile",profileDir,"--headless","--agent-browser-native-required","--no-remote"],
      {encoding:"utf8",timeout:15000});
    const stderr = String(launch.stderr);
    if (launch.status === 0 || !stderr.includes(`AGENT_BROWSER_NATIVE_CONFIG_ERROR: ${expectedError}`)) {
      throw new Error(`Invalid geo/storage config did not fail closed (${label}): ${JSON.stringify({status:launch.status,signal:launch.signal,expectedError,stderr:stderr.slice(-2000)})}`);
    }
  } finally {
    fs.rmSync(profileDir, {recursive:true,force:true});
  }
}
console.log(`Invalid geo/storage configs rejected: ${invalidCases.length}/${invalidCases.length}`);

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
  function geoOnce(scope,watch){
    return new Promise(function(resolve){
      if(!scope.navigator.geolocation){resolve({supported:false});return;}
      var settled=false,id=null;
      var finish=function(value){if(settled)return;settled=true;if(id!==null)scope.navigator.geolocation.clearWatch(id);resolve(value);};
      var success=function(position){finish({supported:true,success:true,coords:{latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,altitude:position.coords.altitude,altitudeAccuracy:position.coords.altitudeAccuracy,heading:position.coords.heading,speed:position.coords.speed},timestampFinite:Number.isFinite(position.timestamp)});};
      var failure=function(error){finish({supported:true,success:false,error:{code:error.code,message:error.message}});};
      var options={enableHighAccuracy:false,maximumAge:0,timeout:5000};
      if(watch) id=scope.navigator.geolocation.watchPosition(success,failure,options);
      else scope.navigator.geolocation.getCurrentPosition(success,failure,options);
      setTimeout(function(){finish({supported:true,success:false,error:{code:-1,message:"verifier-timeout"}});},7000);
    });
  }
  function geoStress(scope,count){
    return new Promise(function(resolve){
      var callbacks=0,successes=0,callbackErrors=0,syncFailures=0,settled=false;
      var finish=function(){
        if(settled||callbacks+syncFailures!==count)return;
        settled=true;resolve({requested:count,callbacks:callbacks,successes:successes,callbackErrors:callbackErrors,syncFailures:syncFailures});
      };
      for(var i=0;i<count;i++){
        try{
          scope.navigator.geolocation.getCurrentPosition(function(){callbacks++;successes++;finish();},function(){callbacks++;callbackErrors++;finish();},{maximumAge:0,timeout:5000});
        }catch(error){syncFailures++;finish();}
      }
      setTimeout(function(){if(!settled){settled=true;resolve({requested:count,callbacks:callbacks,successes:successes,callbackErrors:callbackErrors,syncFailures:syncFailures,timeout:true});}},15000);
    });
  }
  function openDatabase(scope){
    return new Promise(function(resolve,reject){
      var request=scope.indexedDB.open("agent-browser-storage-gate",1);
      request.onupgradeneeded=function(){request.result.createObjectStore("payloads");};
      request.onerror=function(){reject(request.error);};
      request.onsuccess=function(){resolve(request.result);};
    });
  }
  async function estimateSettled(scope,minimumUsage){
    var last=null,stable=0;
    for(var i=0;i<50;i++){
      var current=await scope.navigator.storage.estimate();
      var snapshot={usage:current.usage,quota:current.quota};
      if(last&&snapshot.usage===last.usage&&snapshot.quota===last.quota&&snapshot.usage>=minimumUsage){
        stable++;if(stable>=3)return snapshot;
      }else stable=0;
      last=snapshot;
      await new Promise(function(r){setTimeout(r,300);});
    }
    throw new Error("storage estimate did not settle: "+JSON.stringify({last:last,minimumUsage:minimumUsage}));
  }
  function bytesEqual(a,b){
    if(!a||!b||a.length!==b.length)return false;
    for(var i=0;i<a.length;i++)if(a[i]!==b[i])return false;
    return true;
  }
  async function storageProbe(scope,realmKey){
    var key="blob-"+realmKey;
    var bytes=new Uint8Array(65536);
    (scope.crypto||crypto).getRandomValues(bytes);
    var before=await estimateSettled(scope,0);
    var db=await openDatabase(scope);
    await new Promise(function(resolve,reject){
      var tx=db.transaction("payloads","readwrite");
      tx.objectStore("payloads").put(bytes,key);
      tx.oncomplete=resolve;tx.onerror=function(){reject(tx.error);};tx.onabort=function(){reject(tx.error);};
    });
    var readback=await new Promise(function(resolve,reject){
      var tx=db.transaction("payloads","readonly");
      var request=tx.objectStore("payloads").get(key);
      request.onsuccess=function(){resolve(request.result);};
      request.onerror=function(){reject(request.error);};
      tx.onerror=function(){reject(tx.error);};tx.onabort=function(){reject(tx.error);};
    });
    db.close();
    if(!bytesEqual(readback,bytes))throw new Error("IndexedDB readback mismatch for "+realmKey);
    var after=await estimateSettled(scope,before.usage+49152);
    if(after.usage<=before.usage)throw new Error("storage usage did not increase after write for "+realmKey+": "+JSON.stringify({before:before,after:after}));
    return {before:before,after:after,nativeMethod:methodEvidence(scope.navigator.storage,"estimate"),written:bytes.length,readbackVerified:true};
  }
  function workerMain(shared,realmKey){
    async function run(){return {geolocation:typeof navigator.geolocation,storage:await storageProbe(self,realmKey)};}
    if(shared){self.onconnect=function(event){var port=event.ports[0];run().then(function(v){port.postMessage({supported:true,value:v});port.close();},function(e){port.postMessage({supported:false,error:String(e)});port.close();});};}
    else run().then(function(v){self.postMessage({supported:true,value:v});self.close();},function(e){self.postMessage({supported:false,error:String(e)});self.close();});
  }
  function workerResult(shared,realmKey){
    return new Promise(function(resolve){
      var source=methodEvidence.toString()+";"+openDatabase.toString()+";"+estimateSettled.toString()+";"+bytesEqual.toString()+";"+storageProbe.toString()+";("+workerMain.toString()+")("+(shared?"true":"false")+","+JSON.stringify(realmKey)+");";
      var url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));
      var timer=setTimeout(function(){URL.revokeObjectURL(url);resolve({supported:false,error:"timeout"});},60000);
      if(shared){var worker=new SharedWorker(url);worker.port.onmessage=function(event){clearTimeout(timer);worker.port.close();URL.revokeObjectURL(url);resolve(event.data);};worker.port.start();}
      else{var worker=new Worker(url);worker.onmessage=function(event){clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};}
    });
  }
  var frame=document.createElement("iframe");frame.src=location.origin+"/frame";
  var loaded=new Promise(function(resolve){frame.onload=resolve;setTimeout(resolve,2000);});document.body.appendChild(frame);await loaded;
  await new Promise(function(r){setTimeout(r,1500);});
  var result={
    stress:location.search.indexOf("stress=1")!==-1?await geoStress(window,1510):null,
    window:{current:await geoOnce(window,false),watch:await geoOnce(window,true),storage:await storageProbe(window,"window"),geoNative:{current:methodEvidence(navigator.geolocation,"getCurrentPosition"),watch:methodEvidence(navigator.geolocation,"watchPosition")}},
    iframe:{current:await geoOnce(frame.contentWindow,false),watch:await geoOnce(frame.contentWindow,true),storage:await storageProbe(frame.contentWindow,"iframe"),geoNative:{current:methodEvidence(frame.contentWindow.navigator.geolocation,"getCurrentPosition"),watch:methodEvidence(frame.contentWindow.navigator.geolocation,"watchPosition")}},
    dedicatedWorker:await workerResult(false,"dedicated"),sharedWorker:await workerResult(true,"shared"),
  };
  frame.remove();return result;
})()`;

const server=http.createServer((request,response)=>{response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 Geo Storage Gate</title><body></body>");});
const pagePort=await listen(server);
async function captureWorld(name,config,geoAllow=true,runStress=false){
  const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),`agent-firefox-geo-storage154-${name}-`));
  const port=await freePort();let stderr="",child,connection,context;
  try{
    const prefs={
      ...(config?identity.nativePrefs:{}),
      "geo.enabled":true,
      "geo.prompt.testing":true,
      "geo.prompt.testing.allow":geoAllow,
      "dom.geolocation.require_system_permission.enabled":false,
      "media.devices.unfocused_enabled":true,
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
    context=await bidiCreateContext(connection,15000);await bidiNavigate(connection,`http://127.0.0.1:${pagePort}/?stress=${runStress?"1":"0"}`,context,15000);
    return await bidiEvaluateInContext(connection,expression,context,180000);
  }finally{
    if(context&&connection){try{await bidiCloseContext(connection,context,8000);}catch(error){console.error(String(error));}}
    if(connection)connection.close();
    if(child){child.kill("SIGTERM");await Promise.race([new Promise((resolve)=>child.once("exit",resolve)),sleep(10000).then(()=>{if(child.exitCode===null)child.kill("SIGKILL");})]);}
    fs.rmSync(profileDir,{recursive:true,force:true});
  }
}
function allNative(record,owner){
  return record&&Object.values(record).every((evidence)=>evidence&&evidence.source?.includes("[native code]")&&evidence.owner===owner&&evidence.writable===true&&evidence.enumerable===true&&evidence.configurable===true);
}
function assertStorage(storage,label,minimumQuota){
  if(!storage||!storage.nativeMethod?.source?.includes("[native code]")||storage.nativeMethod.owner!=="StorageManager"||
     storage.readbackVerified!==true||storage.written<65536||
     storage.after.usage<=storage.before.usage||storage.before.quota<storage.before.usage||storage.after.quota<storage.after.usage||
     storage.before.quota<minimumQuota||storage.after.quota<minimumQuota){
    throw new Error(`${label} storage invariant failed: ${JSON.stringify(storage)}`);
  }
}
function assertCustom(world,label){
  for(const realm of ["window","iframe"]){
    if(!allNative(world[realm].geoNative,"Geolocation"))throw new Error(`${label}.${realm} geolocation methods non-native`);
    for(const result of [world[realm].current,world[realm].watch]){
      if(!result.success||result.timestampFinite!==true||result.coords.latitude!==configCustom.geolocation.latitude||result.coords.longitude!==configCustom.geolocation.longitude||result.coords.accuracy!==configCustom.geolocation.accuracy||
         result.coords.altitude!==null||result.coords.altitudeAccuracy!==null||result.coords.heading!==null||result.coords.speed!==null){
        throw new Error(`${label}.${realm} custom geolocation mismatch: ${JSON.stringify(result)}`);
      }
    }
    assertStorage(world[realm].storage,`${label}.${realm}`,configCustom.storageQuotaBytes);
  }
  for(const [realm,worker] of [["dedicated",world.dedicatedWorker],["shared",world.sharedWorker]]){
    if(worker?.supported!==true||worker.value.geolocation!=="undefined")throw new Error(`${label}.${realm} Worker geolocation exposure changed: ${JSON.stringify(worker)}`);
    assertStorage(worker.value.storage,`${label}.${realm}`,configCustom.storageQuotaBytes);
  }
}

try{
  const customA=await captureWorld("custom-a",configCustom,true,true);
  const customB=await captureWorld("custom-b",configCustom,true);
  const denied=await captureWorld("custom-denied",configCustom,false);
  const disabled=await captureWorld("disabled",configDisable,true);
  const lowQuota=await captureWorld("low-quota",configLowQuota,true);
  const real=await captureWorld("real",configReal,true);
  const stock=await captureWorld("stock",null,true);
  assertCustom(customA,"customA");assertCustom(customB,"customB");
  if(customA.stress?.requested!==1510||customA.stress.callbacks!==1510||customA.stress.successes!==1510||customA.stress.callbackErrors!==0||customA.stress.syncFailures!==0||customA.stress.timeout){
    throw new Error(`custom getCurrentPosition stress failed: ${JSON.stringify(customA.stress)}`);
  }
  for(const realm of ["window","iframe"]){
    if(!allNative(stock[realm].geoNative,"Geolocation"))throw new Error(`stock.${realm} geolocation methods non-native`);
    for(const result of [denied[realm].current,denied[realm].watch,disabled[realm].current,disabled[realm].watch]){
      if(result.success||result.error?.code!==1)throw new Error(`${realm} geolocation deny path failed: ${JSON.stringify(result)}`);
    }
    assertStorage(stock[realm].storage,`stock.${realm}`,0);
    assertStorage(lowQuota[realm].storage,`lowQuota.${realm}`,1);
    const expectedManagedQuota=Math.max(stock[realm].storage.after.quota,customA[realm].storage.after.usage,configCustom.storageQuotaBytes);
    if(customA[realm].storage.after.quota!==expectedManagedQuota||
       customA[realm].storage.before.usage!==stock[realm].storage.before.usage||customA[realm].storage.after.usage!==stock[realm].storage.after.usage||
       JSON.stringify(lowQuota[realm].storage.before)!==JSON.stringify(stock[realm].storage.before)||JSON.stringify(lowQuota[realm].storage.after)!==JSON.stringify(stock[realm].storage.after)){
      throw new Error(`${realm} storage max/usage pass-through failed: ${JSON.stringify({managed:customA[realm].storage,low:lowQuota[realm].storage,stock:stock[realm].storage})}`);
    }
    if(real[realm].current.success!==stock[realm].current.success||
       (!real[realm].current.success&&real[realm].current.error?.code!==stock[realm].current.error?.code)){
      throw new Error(`${realm} real geolocation diverged from stock: ${JSON.stringify({real:real[realm].current,stock:stock[realm].current})}`);
    }
  }
  for(const realm of ["dedicatedWorker","sharedWorker"]){
    for(const [label,world] of [["stock",stock],["lowQuota",lowQuota]]){
      if(world[realm]?.supported!==true||world[realm].value.geolocation!=="undefined")throw new Error(`${label}.${realm} Worker shape changed: ${JSON.stringify(world[realm])}`);
      assertStorage(world[realm].value.storage,`${label}.${realm}`,0);
    }
    const managed=customA[realm].value.storage,stockStorage=stock[realm].value.storage,low=lowQuota[realm].value.storage;
    const expectedManagedQuota=Math.max(stockStorage.after.quota,managed.after.usage,configCustom.storageQuotaBytes);
    if(managed.after.quota!==expectedManagedQuota||managed.before.usage!==stockStorage.before.usage||managed.after.usage!==stockStorage.after.usage||
       JSON.stringify(low.before)!==JSON.stringify(stockStorage.before)||JSON.stringify(low.after)!==JSON.stringify(stockStorage.after)){
      throw new Error(`${realm} storage max/usage pass-through failed: ${JSON.stringify({managed,low,stock:stockStorage})}`);
    }
  }
  if(JSON.stringify(customA.window.current.coords)!==JSON.stringify(customB.window.current.coords)||JSON.stringify(customA.window.watch.coords)!==JSON.stringify(customB.window.watch.coords))throw new Error("custom geolocation changed across restarts");
  const result={schemaVersion:1,browser:{engine:"firefox",version:EXPECTED_VERSION,sourceStamp:EXPECTED_SOURCE_STAMP,versionOutput,platform:"macos-arm64",branding:"unofficial"},capture:{mode:"webdriver-bidi-headless-native-geo-storage",fingerprintConfig:configCustom,preloadScript:false,nativeRequired:true},capabilities,evidence:{custom:customA,denied,disabled,lowQuota,real,stock}};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});const staging=`${outputPath}.staging-${process.pid}`;
  if(fs.existsSync(staging))throw new Error(`geo/storage corpus staging path already exists: ${staging}`);
  fs.writeFileSync(staging,`${JSON.stringify(result,null,2)}\n`,"utf8");fs.renameSync(staging,outputPath);
  const text=fs.readFileSync(outputPath,"utf8"),readback=JSON.parse(text);
  assertCustom(readback.evidence.custom,"readback");
  if(readback.browser?.sourceStamp!==EXPECTED_SOURCE_STAMP||readback.capabilities?.sourceStamp!==EXPECTED_SOURCE_STAMP||
     !readback.capabilities?.capabilities?.includes("geolocation-v1")||!readback.capabilities?.capabilities?.includes("storage-quota-v1")||
     readback.capture?.preloadScript!==false||readback.capture?.nativeRequired!==true||readback.evidence?.custom?.stress?.successes!==1510||
     !text.includes('"lowQuota"'))throw new Error("geo/storage corpus readback/search validation failed");
  console.log(`Firefox geo/storage corpus written: ${outputPath}`);
  console.log(`Custom coordinates: ${JSON.stringify(readback.evidence.custom.window.current.coords)}`);
  console.log(`Denied code: ${readback.evidence.denied.window.current.error.code}`);
  console.log(`Quota: ${JSON.stringify(readback.evidence.custom.window.storage)}`);
}finally{await new Promise((resolve)=>server.close(resolve));}
