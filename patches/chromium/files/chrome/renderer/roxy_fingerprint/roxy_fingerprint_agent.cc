// Copyright 2026 The RoxyLite Authors
// Use of this source code is governed by a BSD-style license.

#include "chrome/renderer/roxy_fingerprint/roxy_fingerprint_agent.h"

#include <utility>

#include "base/base64url.h"
#include "base/command_line.h"
#include "base/json/json_reader.h"
#include "base/logging.h"
#include "content/public/renderer/render_frame.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"

namespace {

constexpr char kRoxyFingerprintSwitch[] = "roxy-fingerprint-config";
constexpr size_t kMaxConfigBytes = 64 * 1024;
constexpr int kSupportedSchemaVersion = 1;

}  // namespace

// static
void RoxyFingerprintAgent::MaybeCreate(content::RenderFrame* render_frame) {
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (!command_line->HasSwitch(kRoxyFingerprintSwitch))
    return;

  const std::string encoded =
      command_line->GetSwitchValueASCII(kRoxyFingerprintSwitch);
  std::string decoded;
  if (encoded.empty() ||
      !base::Base64UrlDecode(encoded, base::Base64UrlDecodePolicy::IGNORE_PADDING,
                            &decoded) ||
      decoded.size() > kMaxConfigBytes) {
    LOG(ERROR) << "Invalid Roxy fingerprint configuration encoding";
    return;
  }

  auto config = base::JSONReader::ReadDict(decoded);
  if (!config ||
      config->FindInt("schemaVersion").value_or(0) !=
          kSupportedSchemaVersion) {
    LOG(ERROR) << "Unsupported Roxy fingerprint configuration schema";
    return;
  }

  new RoxyFingerprintAgent(render_frame, std::move(decoded));
}

RoxyFingerprintAgent::RoxyFingerprintAgent(content::RenderFrame* render_frame,
                                           std::string config_json)
    : content::RenderFrameObserver(render_frame),
      config_json_(std::move(config_json)) {}

RoxyFingerprintAgent::~RoxyFingerprintAgent() = default;

void RoxyFingerprintAgent::DidClearWindowObject() {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame)
    return;
  frame->ExecuteScript(blink::WebScriptSource(
      blink::WebString::FromUTF8(BuildInjectionScript())));
}

void RoxyFingerprintAgent::OnDestruct() {
  delete this;
}

std::string RoxyFingerprintAgent::BuildInjectionScript() const {
  // Phase one centralizes every override behind a single versioned config and
  // installs it at DidClearWindowObject. High-value surfaces will move from
  // these bindings into Blink/Skia/WebRTC implementations in later patches.
  return "(()=>{'use strict';const c=" + config_json_ + R"ROXY(;
const nativeSource=new WeakMap();
const originalToString=Function.prototype.toString;
const markNative=(fn,name,kind='get')=>{nativeSource.set(fn,`function ${kind==='get'?'get ':''}${name}() { [native code] }`);return fn;};
const patchedToString=markNative(function toString(){return nativeSource.get(this)||originalToString.call(this);},'toString','function');
Object.defineProperty(Function.prototype,'toString',{value:patchedToString,writable:true,configurable:true});
const getter=(proto,name,value)=>{
  if(!proto)return;
  const old=Object.getOwnPropertyDescriptor(proto,name);
  if(old&&!old.configurable)return;
  Object.defineProperty(proto,name,{get:markNative(function(){return typeof value==='function'?value.call(this):value;},name),enumerable:old?old.enumerable:true,configurable:true});
};
const navProto=Object.getPrototypeOf(navigator);
getter(navProto,'platform',c.platform);
getter(navProto,'userAgent',c.userAgent);
getter(navProto,'appVersion',c.appVersion);
getter(navProto,'vendor',c.vendor);
getter(navProto,'language',c.languages[0]);
getter(navProto,'languages',()=>Object.freeze([...c.languages]));
getter(navProto,'hardwareConcurrency',c.hardwareConcurrency);
getter(navProto,'deviceMemory',c.deviceMemory);
getter(navProto,'maxTouchPoints',c.maxTouchPoints);
getter(navProto,'webdriver',false);
getter(navProto,'doNotTrack',c.doNotTrack);

const chromeMajor=(/Chrome\/(\d+)/.exec(c.userAgent)||[])[1]||'149';
const uaBrands=Object.freeze([
  Object.freeze({brand:'Chromium',version:chromeMajor}),
  Object.freeze({brand:'Google Chrome',version:chromeMajor}),
  Object.freeze({brand:'Not_A Brand',version:'99'})
]);
const uaData=Object.freeze({
  brands:uaBrands,mobile:false,platform:c.platform==='Win32'?'Windows':'macOS',
  getHighEntropyValues:markNative(async function(hints){
    const all={architecture:'x86',bitness:'64',brands:uaBrands,formFactors:['Desktop'],fullVersionList:uaBrands.map(x=>({...x,version:x.brand==='Not_A Brand'?'99.0.0.0':c.userAgent.match(/Chrome\/([\d.]+)/)?.[1]||chromeMajor})),mobile:false,model:'',platform:c.platform==='Win32'?'Windows':'macOS',platformVersion:c.platformVersion,uaFullVersion:c.userAgent.match(/Chrome\/([\d.]+)/)?.[1]||chromeMajor,wow64:false};
    const out={brands:all.brands,mobile:false,platform:all.platform};
    for(const hint of hints||[])if(Object.hasOwn(all,hint))out[hint]=all[hint];
    return out;
  },'getHighEntropyValues','function'),
  toJSON:markNative(function(){return {brands:uaBrands,mobile:false,platform:c.platform==='Win32'?'Windows':'macOS'};},'toJSON','function')
});
getter(navProto,'userAgentData',uaData);

const screenProto=Object.getPrototypeOf(screen);
for(const [name,key] of [['width','width'],['height','height'],['availWidth','availWidth'],['availHeight','availHeight'],['colorDepth','colorDepth'],['pixelDepth','pixelDepth']])getter(screenProto,name,c.screen[key]);
getter(Window.prototype,'devicePixelRatio',c.screen.devicePixelRatio);

const hash=(text)=>{let h=(c.seed>>>0)^0x9e3779b9;for(let i=0;i<text.length;i++){h=Math.imul(h^text.charCodeAt(i),16777619);}return h>>>0;};
const signedNoise=(index,salt,amplitude)=>((hash(`${salt}:${index}`)&1)?1:-1)*amplitude;

if(c.webrtc?.mode==='disable'){
  const DisabledPeerConnection=markNative(function RTCPeerConnection(){throw new DOMException('WebRTC disabled','NotSupportedError');},'RTCPeerConnection','function');
  globalThis.RTCPeerConnection=DisabledPeerConnection;
  if('webkitRTCPeerConnection'in globalThis)globalThis.webkitRTCPeerConnection=DisabledPeerConnection;
}else if(c.webrtc?.mode==='altered'&&c.webrtc.publicIp&&globalThis.RTCPeerConnection){
  const rewrite=(sdp)=>sdp.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,ip=>/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)?ip:c.webrtc.publicIp);
  for(const method of ['createOffer','createAnswer']){const original=RTCPeerConnection.prototype[method];RTCPeerConnection.prototype[method]=markNative(async function(...args){const description=await original.apply(this,args);return new RTCSessionDescription({type:description.type,sdp:rewrite(description.sdp||'')});},method,'function');}
}

if(Array.isArray(c.fonts)&&c.fonts.length&&globalThis.queryLocalFonts){
  const originalQueryLocalFonts=globalThis.queryLocalFonts;
  globalThis.queryLocalFonts=markNative(async function(...args){const fonts=await originalQueryLocalFonts.apply(this,args);const allowed=new Set(c.fonts);return fonts.filter(font=>allowed.has(font.family)||allowed.has(font.fullName));},'queryLocalFonts','function');
}

const rectOffsets=new WeakMap();
const rectNoiseFor=(element)=>{let value=rectOffsets.get(element);if(!value){const n=hash(`${c.seed}:${element.localName||''}:${element.id||''}:${element.className||''}`);value={x:((n&1023)/1023-.5)/100,y:(((n>>>10)&1023)/1023-.5)/100};rectOffsets.set(element,value);}return value;};
const originalBoundingRect=Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect=markNative(function(){const rect=originalBoundingRect.call(this);const n=rectNoiseFor(this);return DOMRectReadOnly.fromRect({x:rect.x+n.x,y:rect.y+n.y,width:rect.width,height:rect.height});},'getBoundingClientRect','function');

if(c.timezone&&globalThis.Intl?.DateTimeFormat){
  const originalResolvedOptions=Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions=markNative(function(){const options=originalResolvedOptions.call(this);return {...options,timeZone:c.timezone};},'resolvedOptions','function');
}

if(c.geolocation?.mode==='disable'&&navigator.geolocation){
  const denied=(success,error)=>queueMicrotask(()=>error?.({code:1,message:'User denied Geolocation'}));
  navigator.geolocation.getCurrentPosition=markNative(denied,'getCurrentPosition','function');
  navigator.geolocation.watchPosition=markNative(denied,'watchPosition','function');
}

Object.defineProperty(globalThis,Symbol.for('roxy.fingerprint.configured'),{value:true,enumerable:false,configurable:false});
})();)ROXY";
}
