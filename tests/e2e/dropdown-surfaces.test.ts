// Hidden-choice acceptance in real isolated Electron. A selectOption call, DOM
// rect or capturePage is NOT native option-popup proof. macOS runs require fresh
// permission-checked, fixture-PID scoped capture/input helpers supplied by the
// runner; missing proof is a blocker, never an implicit green or silent sample.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setupTestApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA=fs.mkdtempSync(path.join(process.env.AGENT_BROWSER_NATIVE_OWNED_ROOT||os.tmpdir(),"studio-dropdown-surfaces-e2e-"));
const evidenceRoot=process.env.AGENT_BROWSER_MENU_EVIDENCE_ROOT;
if(evidenceRoot)fs.mkdirSync(evidenceRoot,{recursive:true});
const EVIDENCE=evidenceRoot?fs.mkdtempSync(path.join(path.resolve(evidenceRoot),"native-select-")):path.join(USERDATA,"evidence");
const CONFIG=path.join(USERDATA,"config.json");
const proofHelper=process.env.AGENT_BROWSER_NATIVE_PROOF_HELPER;
const inputHelper=process.env.AGENT_BROWSER_NATIVE_INPUT_HELPER;
let handle:TestAppHandle;
let nativeSession:any;
// Default deny before Electron launch. A marker is a technical gate, not consent;
// only a later explicitly authorized serial runner may provision it.
async function authorizeNativePreparation() {
  const marker=process.env.AGENT_BROWSER_NATIVE_AUTHORIZATION;
  if(!marker)throw new Error("Native BLOCKED: explicit GUI authorization/source-freeze/shared lease marker absent");
  const owned=(p:string)=>{const s=fs.lstatSync(p);if(!path.isAbsolute(p)||fs.realpathSync(p)!==p||!s.isFile()||s.nlink!==1||s.uid!==process.getuid!()||(s.mode&0o022))throw new Error("Native BLOCKED: unsafe control file");return p;};
  const auth=JSON.parse(fs.readFileSync(owned(marker),"utf8"));
  if(auth.guiAuthorized!==true||auth.sourceFrozen!==true||auth.authorizationKind!=="explicit-user-serial-GUI")throw new Error("Native BLOCKED: GUI authorization false; zero launch/input/capture");
  if(auth.contractVersion!==2||auth.continuityPolicy!=="observed-ax-and-sc-geometry-v1"||typeof auth.closureManifestPath!=="string"||checksum(owned(auth.closureManifestPath))!==auth.closureManifestSha256)throw new Error("Native BLOCKED: current dependency-closure/qualified-continuity contract absent");
  if(!Array.isArray(auth.launchArgvTemplate)||proofHelper!==auth.helperPath||inputHelper!==auth.helperPath)throw new Error("Native BLOCKED: exact frozen helper/launch-vector contract absent");
  const suite=path.resolve(__dirname,"dropdown-surfaces.test.ts");
  if(auth.suitePath!==suite||!Array.isArray(auth.freeze)||!auth.freeze.some((f:any)=>f.path===suite)||!auth.freeze.some((f:any)=>f.path===auth.guardPath))throw new Error("Native BLOCKED: suite/guard source freeze missing");
  for(const f of auth.freeze)if(checksum(owned(f.path))!==f.sha256)throw new Error("Native BLOCKED: source freeze hash changed");
  const guard=await import(pathToFileURL(owned(auth.guardPath)).href);
  nativeSession=guard.prepareGate(marker,{runnerPid:process.pid,checkpointEntry:path.resolve(__dirname,"../.."),suitePath:suite,userData:fs.realpathSync(USERDATA),evidence:fs.realpathSync(EVIDENCE),proofHelper,inputHelper});
}
const nativeGuard=()=>{if(!nativeSession)throw new Error("Native BLOCKED: owned session absent");nativeSession.check();};
let baseline:Buffer;
let serial=0;
let fixturePid:number|undefined;
let setupBlocker:string|undefined;
let captureBehavior="Not yet inspected: capturePage/DOM checks are never native popup proof";
const profiles:Array<{id:string;name:string}>=[];
const rows:any[]=[];
const skips:any[]=[];
const suffix=(prefix:string,parts:string[])=>parts.map(p=>prefix+p);
const groups:Record<string,string[]>={
  profiles:["profile-status-filter","batch-assign-proxy"],
  bulk:["bulk-import-proxy"],
  create:[...suffix("new-profile-",["preset","browser","proxy"]),...suffix("new-agent-browser-",["platform","fingerprint-mode","browser-version","timezone","locale","webrtc-mode","geolocation-mode","render-scale-mode"])],
  edit:suffix("agent-browser-meta-",["fingerprint-mode","browser-version","proxy","platform","timezone","locale","webrtc-mode","geolocation-mode","render-scale-mode"]),
  proxy:["dlg-proxy-type"],
  sync:["sync-merge-strategy"],
  agent:["agent-env-select","agent-llm-provider","agent-fs-mode"],
  automation:["automation-job-status","auto-trigger-type","auto-event","auto-event-profile","auto-action-type","auto-action-profile","auto-action-template"],
  runs:suffix("run-filter-",["range","source","profile","endReason","verification"]),
  activity:["activity-filter"],
  accounts:["acct-import-platform"],
};
const statics=Object.entries(groups).flatMap(([group,ids])=>ids.map(id=>({group,selector:"#"+id,id})));
const dynamic=[
  {group:"profiles",id:"card-proxy",selector:'.proxy-select[data-action="proxy"]'},
  {group:"profiles",id:"card-health",selector:'.health-select[data-action="health"]'},
  ...["profiles","proxies","accounts"].map(section=>({group:"sync",id:"conflict-"+section,selector:`.sync-entry-strategy[data-section="${section}"]`})),
  {group:"sync",id:"team-role",selector:'.team-role-select[data-device-id="ui-only-other-member"]'},
  {group:"sync",id:"team-add-role",selector:"#team-add-role"},
];
const checksum=(p:string)=>createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const manifest=()=>fs.writeFileSync(path.join(EVIDENCE,"coverage-manifest.json"),JSON.stringify({
  userData:USERDATA,source:path.resolve(__dirname,"../.."),pid:fixturePid,
  inventory:{staticSingleSelects:statics.length,dynamicFamilies:5,multiSelects:1,modelAutocomplete:false},
  mandatoryFields:[...statics,...dynamic,{group:"automation",id:"auto-action-profiles",selector:"#auto-action-profiles",inlineMultiple:true}].map(f=>({...f,
    baselineStatus:rows.some(r=>r.id===f.id&&r.kind==="baseline-open-cancel"&&r.verifiedNative)?"verified-native-open-cancel":
      rows.some(r=>r.selector===f.selector&&r.verifiedInline)?"verified-inline-listbox":
      skips.some(r=>r.id===f.id)?"explicit-unavailable":setupBlocker?"not-exercised-setup-blocked":"not-exercised",
    unavailableReason:skips.find(r=>r.id===f.id)?.reason||setupBlocker})),
  rows,skips,setupBlocker,captureBehavior,nativeProof:"Added fixture-owned WindowServer popup + scoped PNG is required; capturePage/DOM alone is insufficient",
  fixtureLimits:"3 genuine trial profiles; loopback proxy fixtures never connected; sync diff/roster and live-run state are explicitly UI-only, no S3/provider/backend claim",
},null,2));

async function input(...args:string[]) {
  nativeGuard();
  // No PID-alone interface, old helper recipe or global HID fallback. A failed
  // activation latches BLOCKED and returns metadata only, including cleanup.
  return nativeSession.input(...args);
}
function proof(stage:string):any {
  nativeGuard();
  const result=nativeSession.proof(stage);
  if(!result.accessibilityAllowed||!result.screenCaptureAllowed)throw new Error(`Native proof blocked: fresh AXIsProcessTrusted=${result.accessibilityAllowed}, CGPreflightScreenCaptureAccess=${result.screenCaptureAllowed}`);
  expect(result.pid).toBe(handle.app.process().pid);
  expect(result.fixtureIsFrontmost,"Fixture PID must own native foreground for option-popup acceptance").toBe(true);
  for(const w of result.windows)expect(w.pid).toBe(handle.app.process().pid);
  for(const w of result.windows.filter((w:any)=>w.screenshot)) {
    expect(w.continuity.policy,"Only qualified observed AX/SC continuity, not an undocumented lifetime generation").toBe("observed-ax-and-sc-geometry-v1");
    expect(w.continuity.lifetimeGenerationProved).toBe(false);
    expect(w.axAssociation.matchingSCWindowIds).toEqual([w.windowId]);
    expect(w.optionEvidence.length).toBe(w.recognizedOptions.length);
  }
  return result;
}
async function anchorNative(state:Awaited<ReturnType<typeof selectState>>) {
  const native=await handle.app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("index.html"))!;return{content:w.getContentBounds(),zoom:w.webContents.getZoomFactor()};});
  nativeSession.setAnchor({options:state.options,screen:{x:native.content.x+state.rect.left*native.zoom,y:native.content.y+state.rect.top*native.zoom,width:state.rect.width*native.zoom,height:state.rect.height*native.zoom}});
}
async function writeCounters() {
  return {changes:await handle.page.evaluate(()=>(window as any).__dropdownChanges.length),writes:JSON.stringify({config:checksum(CONFIG),calls:await handle.page.evaluate(()=>(window as any).__dropdownCalls),roles:await handle.app.evaluate(()=>(globalThis as any).__dropdownIpcFixture?.roleCalls||[])})};
}
async function rendererCapture(stage:string) {
  nativeGuard();nativeSession.verify();
  const image=await handle.app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("index.html"))!.webContents.capturePage()).toPNG().toString("base64"));
  nativeSession.verify();
  fs.writeFileSync(path.join(EVIDENCE,stage+"-capturePage.png"),Buffer.from(image,"base64"));
}
async function resize(width:number,height:number,zoom:number) {
  nativeGuard();nativeSession.verify();
  const native=await handle.app.evaluate(({app,BrowserWindow},s)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("index.html"))!;
    w.setBounds({width:s.width,height:s.height});w.webContents.setZoomFactor(s.zoom);w.show();
    return {outer:w.getBounds(),content:w.getContentBounds(),zoom:w.webContents.getZoomFactor()};},{width,height,zoom});
  nativeSession.verify();
  expect(native.outer.width).toBe(width);expect(native.outer.height).toBe(height);expect(native.zoom).toBe(zoom);
  await handle.page.waitForFunction(expected=>Math.abs(innerWidth-expected)<0.5,native.content.width/zoom);
  expect(await handle.page.evaluate(()=>innerWidth)).toBeCloseTo(native.content.width/zoom,0);
  fs.writeFileSync(path.join(EVIDENCE,`outer-window-${width}x${height}-z${zoom}.json`),JSON.stringify(native,null,2));
  await handle.page.waitForTimeout(180);
}
async function selectState(selector:string) {
  return handle.page.locator(selector).first().evaluate((el:HTMLSelectElement)=>{
    const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return {value:el.value,disabled:el.disabled,multiple:el.multiple,size:el.size,visible:el.getClientRects().length>0,
      selectedOptions:Array.from(el.selectedOptions,o=>o.value),
      rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},foreground:hit===el||!!hit&&el.contains(hit),
      options:Array.from(el.options,o=>({value:o.value,label:o.label,disabled:o.disabled,selected:o.selected})),
      ancestors:Array.from((function*(e:Element|null){while(e){yield e;e=e.parentElement;}})(el)).map(e=>({tag:e.tagName,id:e.id,overflow:getComputedStyle(e).overflow,transform:getComputedStyle(e).transform,scrollTop:e.scrollTop}))};
  });
}
async function openNative(selector:string,stage:string,method:"mouse"|"keyboard"="mouse") {
  await input("activate");
  const loc=handle.page.locator(selector).first();
  await loc.evaluate(el=>el.scrollIntoView({block:"center",inline:"nearest"}));
  await handle.page.waitForTimeout(180);
  const state=await selectState(selector);
  fs.writeFileSync(path.join(EVIDENCE,stage+"-anchor-before-input.json"),JSON.stringify({selector,method,state},null,2));
  await rendererCapture(stage+"-anchor-before-input");
  expect(state.multiple).toBe(false);expect(state.visible,selector).toBe(true);expect(state.foreground,selector).toBe(true);
  expect(state.rect.left).toBeGreaterThanOrEqual(-1);expect(state.rect.right).toBeLessThanOrEqual(state.viewport.width+1);
  expect(state.rect.top).toBeGreaterThanOrEqual(-1);expect(state.rect.bottom).toBeLessThanOrEqual(state.viewport.height+1);
  expect(state.disabled,selector+": do not fake-enable disabled production choices").toBe(false);
  expect(state.options.length,selector).toBeGreaterThan(0);
  await anchorNative(state);
  const counters=await writeCounters();
  const before=proof(stage+"-closed");
  if(method==="keyboard") {nativeSession.verify();await loc.focus();nativeSession.verify();await input("key","Space");}
  else nativeSession.click(before); // PID-targeted native pointer; no global HID fallback.
  await handle.page.waitForTimeout(220);
  const opened=proof(stage+"-opened"); // Capture native surface FIRST.
  const popups=opened.windows.filter((w:any)=>!before.windows.some((old:any)=>old.windowId===w.windowId));
  fs.writeFileSync(path.join(EVIDENCE,stage+".json"),JSON.stringify({selector,method,state,beforeWindows:before.windows,openedWindows:opened.windows,popups},null,2));
  await rendererCapture(stage); // Deliberately not used as popup visibility proof.
  expect(popups.length,`${selector}: no new fixture-owned OS popup; visibility unverified (${stage})`).toBeGreaterThan(0);
  for(const w of popups){expect(w.screenshotExit).toBe(0);expect(w.screenshot).toBeTruthy();expect(fs.statSync(w.screenshot).size).toBeGreaterThan(1000);}
  return {state,before,opened,popups,stage,counters};
}
async function cancelNative(opened:Awaited<ReturnType<typeof openNative>>,selector:string) {
  await input("key","Escape");await handle.page.waitForTimeout(130);
  const closed=proof(opened.stage+"-cancelled");
  for(const p of opened.popups)expect(closed.windows.some((w:any)=>w.windowId===p.windowId),selector+": native Escape must dismiss popup").toBe(false);
  const current=await selectState(selector);
  expect(current.value,selector+": cancelling must not dispatch an immediate write").toBe(opened.state.value);
  nativeSession.cancel(opened,{value:opened.state.value,...opened.counters},{value:current.value,...await writeCounters()});
}
async function closeDialogs() {
  nativeGuard();nativeSession.verify();
  await handle.page.evaluate(()=>{const ab=(window as any).agentBrowser;ab.closeCardMenus(document,false);
    for(const d of document.querySelectorAll("dialog[open]"))(d as HTMLDialogElement).close();});
  nativeSession.verify();
}
async function route(tab:string) {
  nativeGuard();nativeSession.verify();
  await handle.page.evaluate(tab=>(window as any).agentBrowser.switchTab(tab),tab);
  nativeSession.verify();
  await handle.page.waitForTimeout(220);
}
async function chooseEditor(selector:string,value:string) {
  // Only unsaved editor choices. No role/proxy/health mutation uses this helper.
  const stage=`${String(++serial).padStart(3,"0")}-editor-${selector.replace(/[^a-z0-9]/gi,"-")}`;
  const opened=await openNative(selector,stage,"keyboard");
  const target=opened.state.options.findIndex(o=>o.value===value),selected=opened.state.options.findIndex(o=>o.selected);
  expect(target).toBeGreaterThanOrEqual(0);expect(opened.state.options[target].disabled).toBe(false);
  for(let i=0;i<Math.abs(target-selected);i++)await input("key",target>selected?"ArrowDown":"ArrowUp");
  await input("key","Enter");await handle.page.waitForTimeout(140);
  expect((await selectState(selector)).value).toBe(value);
  rows.push({selector,stage,kind:"editor-change",value,verifiedNative:true});manifest();
}
async function prepare(group:string,id:string) {
  await closeDialogs();
  if(group==="profiles") {
    await route("profiles");await expect.poll(()=>handle.page.locator("#profile-list .profile-card").count()).toBe(profiles.length);
    if(id==="batch-assign-proxy")await handle.page.locator("#profile-list .profile-select-checkbox").first().check();
  }else if(group==="bulk") {await route("profiles");await handle.page.evaluate(()=>(window as any).agentBrowser.bulkImport());await handle.page.locator("#dlg-bulk-import").waitFor({state:"visible"});
  }else if(group==="create") {
    await route("profiles");await handle.page.locator('#tab-profiles [data-cmd="newProfile"]').first().click();await handle.page.locator("#dlg-profile").waitFor({state:"visible"});
    if(id.startsWith("new-agent-browser-")&&id!=="new-agent-browser-platform")await handle.page.locator("#new-profile-advanced > summary").click();
  }else if(group==="edit") {await route("profiles");await handle.page.locator(`#profile-list .profile-card[data-dir-id="${profiles[0].id}"] [data-action="edit"]`).click();await handle.page.locator("#dlg-agent-browser-seed").waitFor({state:"visible"});
  }else if(group==="proxy") {await route("proxy");await handle.page.evaluate(()=>(window as any).agentBrowser.newProxy());await handle.page.locator("#dlg-proxy").waitFor({state:"visible"});
  }else if(group==="accounts") {await route("accounts");await handle.page.locator("#acct-bulk-import-btn").click();await handle.page.locator("#dlg-account-import").waitFor({state:"visible"});await handle.page.locator("#acct-import-create-profiles").check();
  }else if(group==="agent") {
    await route("agent");await handle.page.evaluate(view=>(window as any).agentBrowser.switchAgentSub(view),id==="agent-env-select"?"chat":"config");
    if(id==="agent-env-select")await handle.page.evaluate(()=>(window as any).agentBrowser.agentRefreshEnvironments());
  }else if(group==="automation") {
    await route("automation");if(id!=="automation-job-status") {
      await handle.page.locator('#tab-automation [data-cmd="automationNew"]').first().click();await handle.page.locator("#dlg-automation").waitFor({state:"visible"});
      await expect.poll(()=>handle.page.locator("#auto-action-profile option").count()).toBe(profiles.length+1);
      if(["auto-event","auto-event-profile"].includes(id))await chooseEditor("#auto-trigger-type","event");
      if(["auto-action-template","auto-action-profiles"].includes(id))await chooseEditor("#auto-action-type","agent-task");
      if(id==="auto-action-profiles")await handle.page.locator("#auto-action-batch").check();
    }
  }else if(group==="sync") {
    await route("sync");await handle.page.evaluate(async()=>{const ab=(window as any).agentBrowser;await ab.loadSyncDiff();ab.loadTeamPanel();});
    await expect.poll(()=>handle.page.locator("#team-add-role").count()).toBe(1);
  }else await route(group);
  await handle.page.waitForTimeout(130);
}
async function verifyNoProfileWrites() {
  expect(await handle.app.evaluate(()=>(globalThis as any).__dropdownIpcFixture?.roleCalls||[]),"UI-only roster must not commit an immediate role write").toEqual([]);
  expect(fs.readFileSync(CONFIG)).toEqual(baseline);
  const index=path.join(USERDATA,"trash","index.json");expect(fs.existsSync(index)?JSON.parse(fs.readFileSync(index,"utf8")):[]).toEqual([]);
  expect(await handle.page.evaluate(()=>(window as any).agentBrowser.api.app.reloadConfig())).toMatchObject({success:true});
  const listed=await handle.page.evaluate(()=>(window as any).agentBrowser.api.browser.list());
  for(const p of profiles){expect(listed.find((x:any)=>x.dirId===p.id)?.name).toBe(p.name);
    expect((await handle.page.evaluate(id=>(window as any).agentBrowser.api.profile.get(id),p.id)).name).toBe(p.name);
    expect(fs.readFileSync(path.join(USERDATA,"profiles",p.id,"Default","dropdown-sentinel.txt"),"utf8")).toBe(p.name);}
  const calls=await handle.page.evaluate(()=>(window as any).__dropdownCalls as string[]);
  expect(calls.filter(k=>/^(browser\.(launch|create|setMeta)|profile\.(trash|import)|proxy\.(setProfile|delete|test)|automation\.(save|run)|agent\.chat)/.test(k))).toEqual([]);
}

describe("all inventoried native dropdown surfaces — real option-popup acceptance",()=>{
  beforeAll(async()=>{
    try {
    fs.mkdirSync(EVIDENCE,{recursive:true});manifest();
    if(process.platform!=="darwin"||!proofHelper||!inputHelper)throw new Error("Native popup visibility blocker: this macOS acceptance requires supplied fresh-authorized fixture-PID input/capture helpers. No all-green claim is possible with DOM-only checks.");
    await authorizeNativePreparation();
    const launchEarliestMs=Date.now();
    handle=await setupTestApp({userDataDir:USERDATA,resetUserData:false,keepInitialDialogs:true,env:{AGENT_BROWSER_CHROMIUM_CACHE_DIR:path.join(USERDATA,"chromium-cache")},timeoutMs:60_000});
    fixturePid=handle.app.process().pid;
    nativeSession.bind(fixturePid,launchEarliestMs,Date.now(),handle.app.process().spawnargs);
    await input("activate");
    fs.writeFileSync(path.join(EVIDENCE,"fixture-process.json"),JSON.stringify({pid:fixturePid,userData:USERDATA,source:path.resolve(__dirname,"../.."),
      runnerPid:process.pid,identity:JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BROWSER_NATIVE_OWNED_ROOT!,"owned-nonce-manifest.json"),"utf8"))},null,2));
    const isolation=await handle.app.evaluate(({app})=>({userData:app.getPath("userData"),home:process.getBuiltinModule("node:os").homedir(),electron:process.versions.electron,
      providerKeys:Object.keys(process.env).filter(k=>/^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(k))}));
    expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(USERDATA));expect(fs.realpathSync(isolation.home)).toBe(fs.realpathSync(path.join(USERDATA,"test-home")));expect(isolation.providerKeys).toEqual([]);
    await handle.page.locator("#dlg-terms").waitFor({state:"visible"});await handle.page.locator("#terms-ack").check();await handle.page.locator("#terms-accept-btn").click();
    await handle.page.evaluate(()=>{(window as any).wizardDismissed=true;localStorage.setItem("agent-browser-studio-wizard-dismissed","1");for(const d of document.querySelectorAll("dialog[open]"))(d as HTMLDialogElement).close();(window as any).i18n.set("en-US");});
    const license=await handle.page.evaluate(()=>(window as any).agentBrowser.api.license.status());expect(license.plan).toBe("trial");expect(license.expired).toBe(false);expect(license.maxProfiles).toBeGreaterThanOrEqual(3);
    for(const [i,name] of ["Dropdown synthetic long English label "+"unbrokenProfileName".repeat(4),"下拉隐藏选项验收合成环境长名称".repeat(5),"Dropdown short fixture"].entries()){
      const r=await handle.page.evaluate(({i,name})=>(window as any).agentBrowser.api.browser.create({name,platform:"windows",fingerprintMode:"managed",fingerprintSeed:5000+i,proxyMode:"none"}),{i,name});
      expect(r.dirId).toBeTruthy();profiles.push({id:r.dirId,name});const sent=path.join(USERDATA,"profiles",r.dirId,"Default","dropdown-sentinel.txt");fs.mkdirSync(path.dirname(sent),{recursive:true});fs.writeFileSync(sent,name);
      expect(JSON.parse(fs.readFileSync(CONFIG,"utf8")).browserProfiles[r.dirId].name).toBe(name);
    }
    for(const [i,name] of ["Dropdown-English-proxy-"+"longLabel".repeat(4),"Dropdown-proxy-second-"+"LongNativeLabel".repeat(2)].entries())expect(await handle.page.evaluate(({i,name})=>(window as any).agentBrowser.api.proxy.add(name,{type:"http",host:"127.0.0.1",port:25000+i}),{i,name})).toMatchObject({success:true});
    // contextBridge freezes agentBrowserAPI: assigning renderer API methods did
    // not install the old roster/diff fixture. Intercept only these three IPC
    // handlers in this newly owned Electron main; restore exact originals below.
    // UI-only data, not team/RBAC/S3 persistence or a backend acceptance claim.
    await handle.app.evaluate(({ipcMain})=>{
      const table=(ipcMain as any)._invokeHandlers as Map<string,Function>;
      if(!(table instanceof Map))throw new Error("UI-only IPC fixture blocked: handler table unavailable");
      const channels=["sync:preview-diff","team:status","team:set-role"];
      const originals=channels.map(channel=>{const handler=table.get(channel);if(!handler)throw new Error("Missing production handler "+channel);return{channel,handler};});
      (globalThis as any).__dropdownIpcFixture={originals,roleCalls:[]};
      const section=(id:string)=>({localOnly:[],remoteOnly:[],changed:[{id,fields:["name","updatedAt"]}]});
      const handlers:Record<string,Function>={
        "sync:preview-diff":async()=>({ok:true,firstPush:false,remoteTimestamp:Date.now(),profiles:section("ui-only-profile-conflict"),proxies:section("ui-only-proxy-conflict"),accounts:section("ui-only-account-conflict"),extensions:{localOnly:[],remoteOnly:[],changed:[]},artifacts:{cookies:[],localStorage:[],preferences:[]},pushWarnings:[],pullNotes:[]}),
        "team:status":async()=>({local:{deviceId:"ui-only-local-admin",name:"UI-only local admin",role:"admin"},team:{name:"UI-only roster, NOT persisted",ownerDeviceId:"ui-only-owner",enabled:true,members:[{deviceId:"ui-only-owner",name:"UI-only owner",role:"owner"},{deviceId:"ui-only-local-admin",name:"UI-only local admin",role:"admin"},{deviceId:"ui-only-other-member",name:"UI-only other member long English / 长中文标签".repeat(3),role:"member"}]}}),
        "team:set-role":async(_event:any,...args:any[])=>{(globalThis as any).__dropdownIpcFixture.roleCalls.push(args);return{success:false,error:"UI-only fixture: no backend role mutation allowed"};},
      };
      for(const channel of channels){ipcMain.removeHandler(channel);ipcMain.handle(channel,handlers[channel] as any);}
    });
    await handle.page.evaluate(()=>{
      const ab=(window as any).agentBrowser;const originals={ipc:ab.ipc.call};(window as any).__dropdownOriginals=originals;
      (window as any).__dropdownCalls=[];(window as any).__dropdownChanges=[];(window as any).__dropdownUiRoleCalls=[];
      ab.ipc.call=function(key:string,fn:Function,opts:any){(window as any).__dropdownCalls.push(key);return originals.ipc.call(this,key,fn,opts);};
      document.addEventListener("change",(e:any)=>{if(e.target.tagName==="SELECT")(window as any).__dropdownChanges.push({id:e.target.id,classes:e.target.className,value:e.target.value,selectedOptions:Array.from(e.target.selectedOptions,(o:any)=>o.value),trusted:e.isTrusted});},true);
    });
    expect(await handle.page.evaluate(()=>(window as any).agentBrowser.api.team.status())).toMatchObject({local:{deviceId:"ui-only-local-admin",role:"admin"}});
    expect(await handle.page.evaluate(()=>(window as any).agentBrowser.api.sync.previewDiff())).toMatchObject({ok:true,profiles:{changed:[{id:"ui-only-profile-conflict"}]}});
    // One legitimate local-only synthetic conversation prevents the normal
    // Agent first-view auto-create from being mistaken for an editor write.
    const conversation=await handle.page.evaluate(()=>(window as any).agentBrowser.api.agent.conversations.create("Dropdown local synthetic conversation — no messages/provider"));
    expect(conversation.id).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(USERDATA,"agent-conversations.json"),"utf8")).some((c:any)=>c.id===conversation.id&&c.messages.length===0)).toBe(true);
    expect((await handle.page.evaluate(()=>(window as any).agentBrowser.api.agent.conversations.list())).some((c:any)=>c.id===conversation.id)).toBe(true);
    expect((await handle.page.evaluate(id=>(window as any).agentBrowser.api.agent.conversations.get(id),conversation.id)).messages).toEqual([]);
    baseline=fs.readFileSync(CONFIG);await resize(1100,750,1);
    const html=fs.readFileSync(path.resolve(__dirname,"../../src/renderer/index.html"),"utf8");
    const htmlIds=[...html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(m=>m[1]);
    expect(statics).toHaveLength(42);expect(new Set([...statics.map(s=>s.id),"auto-action-profiles"])).toEqual(new Set(htmlIds));
    const hashes=Object.fromEntries(["src/renderer/index.html","src/renderer/css/style.css","src/renderer/js/app/delegation.js","src/renderer/js/app/profiles.js","src/renderer/js/app/proxies.js","src/renderer/js/app/tabs.js"].map(p=>[p,checksum(path.resolve(__dirname,"../..",p))]));
    fs.writeFileSync(path.join(EVIDENCE,"isolation-and-checkpoint.json"),JSON.stringify({isolation,license,profiles,hashes,configSha256:checksum(CONFIG),emptyBrowserCache:path.join(USERDATA,"chromium-cache")},null,2));
    console.log(`DROPDOWN_EVIDENCE ${EVIDENCE}; USERDATA ${USERDATA}`);
    // Inspect this runtime's actual capture behavior before trusting any popup
    // evidence. Only the known fixture PID's main/child windows are captured.
    await input("activate");
    const calibrationState=await selectState("#profile-status-filter");
    await anchorNative(calibrationState);
    const calibrationCounters=await writeCounters();
    const closed=proof("capture-behavior-closed");
    await rendererCapture("capture-behavior-closed");
    nativeSession.click(closed); // PID-targeted attempt; native effect still must be proven.
    await handle.page.waitForTimeout(220);
    const opened=proof("capture-behavior-opened");
    await rendererCapture("capture-behavior-opened");
    const popups=opened.windows.filter((w:any)=>!closed.windows.some((old:any)=>old.windowId===w.windowId));
    captureBehavior=popups.length?"Actual native popup window acquired; inspect paired capturePage and fixture-popup PNGs (DOM image alone is not proof)":
      "No fixture-owned native popup window acquired; capturePage shows renderer only and cannot establish native visibility";
    fs.writeFileSync(path.join(EVIDENCE,"capture-behavior.json"),JSON.stringify({closed,opened,popups,captureBehavior},null,2));
    // Never attempt renderer/global Escape after a foreground failure.
    await input("key","Escape");
    await handle.page.waitForTimeout(130);
    if(!opened.fixtureIsFrontmost) {
      setupBlocker=`Native option-popup acceptance blocked: fresh AXIsProcessTrusted=${opened.accessibilityAllowed}, CGPreflightScreenCaptureAccess=${opened.screenCaptureAllowed}, but isolated fixture PID ${fixturePid} is not native foreground. No global/lock-screen input or screen capture is permitted.`;
      manifest();throw new Error(setupBlocker);
    }
    if(!popups.length) {
      setupBlocker="Native visibility blocker: trusted select click did not produce an identifiable fixture-owned native option window; inspect capture-behavior evidence, not DOM rects/selectOption";
      manifest();throw new Error(setupBlocker);
    }
    const cancelled=proof("capture-behavior-cancelled");
    if(popups.some((p:any)=>cancelled.windows.some((w:any)=>w.windowId===p.windowId))) {
      setupBlocker="Native input calibration blocker: Escape did not dismiss the identified option surface. Retain closed/opened/cancelled PID-window captures; never treat a pre-existing popup as a newly opened selector.";
      manifest();throw new Error(setupBlocker);
    }
    nativeSession.cancel({stage:"capture-behavior",popups},{value:calibrationState.value,...calibrationCounters},{value:(await selectState("#profile-status-filter")).value,...await writeCounters()});
    manifest();
    }catch(error){setupBlocker=setupBlocker||String(error);manifest();throw error;}
  },90_000);
  afterEach(async()=>{
    if(!handle||setupBlocker||!nativeSession||nativeSession.blocked){manifest();return;}
    try{await input("key","Escape");}finally{if(!nativeSession.blocked)await closeDialogs();manifest();}
  });
  afterAll(async()=>{
    // Failed activation/identity/proof means metadata-only, even cleanup. The
    // later authorized runner owns process shutdown; never send fallback Escape.
    if(handle&&!setupBlocker&&nativeSession&&!nativeSession.blocked){try{
      nativeSession.verify();
      await handle.page.evaluate(()=>{const ab=(window as any).agentBrowser,o=(window as any).__dropdownOriginals;if(o)ab.ipc.call=o.ipc;});
      await handle.app.evaluate(({ipcMain})=>{const f=(globalThis as any).__dropdownIpcFixture;if(f){for(const {channel,handler} of f.originals){ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);}delete (globalThis as any).__dropdownIpcFixture;}});
    }finally{if(!nativeSession.blocked){nativeSession.verify();await handle.app.close();}}} // Owned launch handle only; never closeApp's pkill-by-substring sweep.
    manifest(); // Retain only fresh test-owned data and captures; no cleanup of old runs.
  },90_000);

  for(const field of [...statics,...dynamic])it(`${field.group}: genuinely opens and cancels ${field.selector}`,async(ctx)=>{
    const stage=`${String(++serial).padStart(3,"0")}-${field.id}`;
    try{
      await prepare(field.group,field.id);
      const state=await selectState(field.selector);
      if(state.disabled||!state.visible||!state.options.length){const reason=state.disabled?"production control is disabled":!state.visible?"conditional owner unavailable after its real entry flow":"production option list is empty";
        skips.push({...field,stage,reason,state});manifest();ctx.skip(reason);return;}
      const changes=await handle.page.evaluate(()=>(window as any).__dropdownChanges.length);
      const opened=await openNative(field.selector,stage,serial%2?"mouse":"keyboard");await cancelNative(opened,field.selector);
      expect(await handle.page.evaluate(()=>(window as any).__dropdownChanges.length)).toBe(changes);
      rows.push({...field,stage,kind:"baseline-open-cancel",verifiedNative:true,options:state.options,oneOptionOnly:state.options.length===1,
        emptyBuildReason:field.id.endsWith("browser-version")?"Explicit empty test cache: no installed build choices; Auto option genuinely opened, binary availability is NOT claimed":undefined});
      await verifyNoProfileWrites();manifest();
    }catch(e){rows.push({...field,stage,kind:"failed",error:String(e)});manifest();throw e;}
  });

  it("unsaved automation conditional choices dispatch once and reveal the expected event/agent rows",async()=>{
    await prepare("automation","auto-trigger-type");
    let count=await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="auto-trigger-type").length);
    await chooseEditor("#auto-trigger-type","event");
    expect(await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="auto-trigger-type").length)).toBe(count+1);
    expect(await handle.page.locator("#auto-event").isVisible()).toBe(true);expect(await handle.page.locator("#auto-event-profile").isVisible()).toBe(true);expect(await handle.page.locator("#auto-cron").isVisible()).toBe(false);
    count=await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="auto-action-type").length);
    await chooseEditor("#auto-action-type","agent-task");
    expect(await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="auto-action-type").length)).toBe(count+1);
    expect(await handle.page.locator("#auto-action-template").isVisible()).toBe(true);expect(await handle.page.locator("#auto-action-batch").isVisible()).toBe(true);
    await verifyNoProfileWrites();
  });

  it("real native typeahead selects SOCKS5H exactly once in the unsaved proxy editor",async()=>{
    await prepare("proxy","dlg-proxy-type");const changes=await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="dlg-proxy-type").length);
    const opened=await openNative("#dlg-proxy-type",`${++serial}-proxy-typeahead`,"keyboard");
    await input("key","SOCKS5H");await input("key","Enter");await handle.page.waitForTimeout(150);
    expect((await selectState("#dlg-proxy-type")).value).toBe("socks5h");
    expect(await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="dlg-proxy-type").length)).toBe(changes+1);
    rows.push({selector:"#dlg-proxy-type",stage:opened.stage,kind:"native-typeahead",verifiedNative:true,value:"socks5h"});await verifyNoProfileWrites();manifest();
  });

  it("UI-only admin roster disabled Owner/Admin options remain unavailable to native keyboard traversal",async()=>{
    await prepare("sync","team-add-role");const state=await selectState("#team-add-role");
    expect(state.options.filter(o=>o.disabled).map(o=>o.value)).toEqual(["admin","owner"]);
    const opened=await openNative("#team-add-role",`${++serial}-disabled-admin-options`,"keyboard");
    // Walk past the last enabled Member toward disabled Admin/Owner. They must
    // never become selected; native traversal stops on the enabled member.
    for(let i=0;i<state.options.length+1;i++)await input("key","ArrowDown");
    await input("key","Enter");await handle.page.waitForTimeout(140);
    expect((await selectState("#team-add-role")).value).toBe("member");
    rows.push({selector:"#team-add-role",stage:opened.stage,kind:"disabled-options-traversal",verifiedNative:true,disabled:["admin","owner"]});
    await chooseEditor("#team-add-role","viewer");
    expect((await selectState("#team-add-role")).value).toBe("viewer");
    expect(await handle.page.evaluate(()=>(window as any).__dropdownUiRoleCalls)).toEqual([]);await verifyNoProfileWrites();
  });

  it("inline multiple size=6 list preserves actual Cmd-click selectedOptions semantics without creating a popup",async()=>{
    await prepare("automation","auto-action-profiles");const loc=handle.page.locator("#auto-action-profiles");
    const before=await selectState("#auto-action-profiles");expect(before.multiple).toBe(true);expect(before.size).toBe(6);expect(before.options).toHaveLength(profiles.length);
    const changes=await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="auto-action-profiles").length);
    await loc.locator("option").nth(0).click();await loc.locator("option").nth(1).click({modifiers:["Meta"]});
    const selected=await selectState("#auto-action-profiles");expect(selected.selectedOptions).toEqual(before.options.slice(0,2).map(o=>o.value));
    expect(await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.id==="auto-action-profiles").length)).toBe(changes+2);
    await rendererCapture("inline-multiselect");rows.push({selector:"#auto-action-profiles",kind:"inline-multiple",selectedOptions:selected.selectedOptions,verifiedInline:true,notPopup:true});await verifyNoProfileWrites();manifest();
  });

  it("health History dispatches once, resets the selector, and never runs an external/browser health check",async()=>{
    await prepare("profiles","card-health");const selector='.health-select[data-action="health"]';const before=await selectState(selector);
    const changes=await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.classes.includes("health-select")).length);
    const opened=await openNative(selector,`${++serial}-health-history`,"keyboard");
    // History is the only deliberately committed action; it reads existing local
    // history and shows an informational empty toast. Do not run drift/lock/risk.
    const index=before.options.findIndex(o=>o.value==="history");for(let i=0;i<index;i++)await input("key","ArrowDown");await input("key","Enter");
    await handle.page.waitForTimeout(180);expect((await selectState(selector)).value).toBe("");
    expect(await handle.page.evaluate(()=>(window as any).__dropdownChanges.filter((e:any)=>e.classes.includes("health-select")).length)).toBe(changes+1);
    expect(await handle.page.locator(".toast-stack").innerText()).toMatch(/No health checks recorded|无.*检查/);
    rows.push({selector,stage:opened.stage,kind:"health-history-reset",verifiedNative:true});await verifyNoProfileWrites();manifest();
  });

  it("UI-only live-run state disables the genuine Agent environment select and forbids a native popup",async()=>{
    await prepare("agent","agent-env-select");
    await handle.page.waitForFunction(()=>(window as any).agentBrowser.state.agentActiveConvId);
    await handle.page.evaluate(id=>{const ab=(window as any).agentBrowser,session=ab.agentChatSessions[ab.state.agentActiveConvId];
      (window as any).__dropdownUiSession={session,run:session.run};session.run={runId:"ui-only-not-a-backend-run",state:"running",profileDirId:id,profileName:"UI-only frozen environment"};},profiles[0].id);
    try{
      await handle.page.evaluate(()=>(window as any).agentBrowser.agentRefreshEnvironments());
      const state=await selectState("#agent-env-select");expect(state.disabled).toBe(true);expect(state.value).toBe(profiles[0].id);
      const loc=handle.page.locator("#agent-env-select");await loc.evaluate(el=>el.scrollIntoView({block:"center"}));
      const g=await selectState("#agent-env-select");await anchorNative(g);
      const before=proof("live-disabled-before");
      nativeSession.click(before);
      const after=proof("live-disabled-after");expect(after.windows.map((w:any)=>w.windowId)).toEqual(before.windows.map((w:any)=>w.windowId));
      skips.push({selector:"#agent-env-select",state:"live-run",reason:"Production-disabled via explicitly UI-only session.run; no backend run created",verifiedDisabled:true});await verifyNoProfileWrites();manifest();
    }finally{if(!nativeSession.blocked){nativeSession.verify();await handle.page.evaluate(async()=>{const f=(window as any).__dropdownUiSession;f.session.run=f.run;delete (window as any).__dropdownUiSession;await (window as any).agentBrowser.agentRefreshEnvironments();});}}
  });

  // Every baseline field above is mandatory. Only representative geometry
  // groups are stressed: long scrolling Create/Edit, compact card, chat toolbar,
  // inline sync conflict and conditional automation. This is explicitly NOT a
  // claim that every selector was multiplied across every geometry/language.
  for(const language of ["en-US","zh-CN"])for(const width of [1100,800])for(const zoom of [1,1.25,1.5]) {
    it(`representative geometry groups with long ${language} labels at ${width}x${width===1100?750:600} zoom ${zoom}`,async()=>{
      await handle.page.evaluate(language=>(window as any).i18n.set(language),language);await resize(width,width===1100?750:600,zoom);
      for(const field of [statics.find(s=>s.id==="new-agent-browser-timezone")!,statics.find(s=>s.id==="agent-browser-meta-render-scale-mode")!,dynamic[0],statics.find(s=>s.id==="agent-env-select")!,dynamic[2],statics.find(s=>s.id==="auto-action-template")!]) {
        const stage=`${++serial}-stress-${language}-${width}-z${zoom}-${field.id}`;
        try{await prepare(field.group,field.id);const opened=await openNative(field.selector,stage);await cancelNative(opened,field.selector);
          rows.push({...field,stage,kind:"representative-stress",language,width,zoom,verifiedNative:true});manifest();
        }catch(e){rows.push({...field,stage,kind:"failed-stress",language,width,zoom,error:String(e)});manifest();throw e;}
      }
      await verifyNoProfileWrites();
    },90_000);
  }
  it("records complete field-by-field baseline coverage and retains storage readbacks",async()=>{
    const covered=new Set(rows.filter(r=>r.kind==="baseline-open-cancel"&&r.verifiedNative).map(r=>r.id));
    for(const f of [...statics,...dynamic])expect(covered.has(f.id),`${f.selector}: not exercised, inspect explicit skips; do not claim complete acceptance`).toBe(true);
    await verifyNoProfileWrites();
    fs.writeFileSync(path.join(EVIDENCE,"final-storage-readback.json"),JSON.stringify({config:JSON.parse(fs.readFileSync(CONFIG,"utf8")),profiles,
      calls:await handle.page.evaluate(()=>(window as any).__dropdownCalls),roleFixtureCalls:await handle.page.evaluate(()=>(window as any).__dropdownUiRoleCalls),
      changes:await handle.page.evaluate(()=>(window as any).__dropdownChanges)},null,2));manifest();
  });
});
