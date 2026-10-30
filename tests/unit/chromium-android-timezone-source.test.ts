import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const PATCH_ROOT = path.join(ROOT, "patches", "chromium");
const PATCH = "patches/0057-android-frozen-native-timezone.patch";
const read = (file: string) => fs.existsSync(path.join(PATCH_ROOT, file))
  ? fs.readFileSync(path.join(PATCH_ROOT, file), "utf8") : "";
const patch = read(PATCH);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const section = (file: string) => patch.split(/^diff --git /m)
  .find((value) => value.startsWith(`a/${file} b/${file}\n`)) || "";
const additions = (file: string) => section(file).split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1)).join("\n");
const CONFIG = "third_party/blink/public/common/agent_browser_android_timezone_config.h";
const TIMEZONE = "third_party/blink/renderer/core/timezone/timezone_controller.cc";
const CLIENT = "content/shell/browser/shell_content_browser_client.cc";
const JAVA = "content/shell/android/shell_apk/src/org/chromium/content_shell_apk/";
const config = additions(CONFIG);
const timezone = additions(TIMEZONE);
const client = additions(CLIENT);
const application = additions(`${JAVA}AgentBrowserTimezoneApplication.java`);
const activity = additions(`${JAVA}AgentBrowserTimezoneActivity.java`);
const gn = additions("content/shell/android/BUILD.gn");

// Source contracts only. These assertions do not execute C++, Java, an APK,
// renderer, Date/Intl or any browser realm, and cannot establish runtime PASS.
describe("Android frozen native timezone source contracts (not native acceptance)", () => {
  it("adds 0057 without rewriting a released patch, payload or desktop parser", () => {
    expect(patch).not.toBe("");
    const prior = read("PATCHSET.sha256").split(/\r?\n/)
      .filter((line) => {
        if (!line || line.endsWith("  PATCHED_SOURCE.sha256")) return false;
        const numbered = / {2}patches\/(\d{4})-/.exec(line);
        return !numbered || numbered[1] < "0057";
      }).join("\n") + "\n";
    expect(sha(prior)).toBe("9145e5a3bd993b3ab05ff3352f63f2d57a45d71d5278cdd55293981dfc61e5b8");
    expect(sha(patch)).toBe("725b79cd20457bfe0634e7029ffbe3d4a317ad00fbcb369290d4af15a0c59fdf");
    expect(patch).not.toContain("+++ b/third_party/blink/public/common/roxy_fingerprint_config.h");
    expect(config).not.toMatch(/enabled_\s*=|GetUserAgentMetadata|Win32|MacIntel/);
    expect(config).toContain("#if BUILDFLAG(IS_ANDROID)");
  });

  it("selects an immutable process snapshot without a production setter or reset", () => {
    expect(config).toContain("static const base::NoDestructor<AgentBrowserAndroidTimezoneConfig> config;");
    expect(config).toContain("friend class AgentBrowserAndroidTimezoneConfigTestPeer;");
    expect(config).toContain("const base::CommandLine& command_line");
    expect(config).not.toMatch(/Reset|SetTimezone|SetConfig|const_cast|RegisterRuntime/);
  });

  it("distinguishes required-but-missing input from a genuinely unconfigured process", () => {
    expect(config).toContain('kRequiredSwitch[] = "agent-browser-timezone-required"');
    expect(config).toContain("requested_ = has_payload || command_line.HasSwitch(kRequiredSwitch)");
    expect(config).toContain("requested_ && !valid_");
    expect(config).toContain("if (!has_payload");
  });

  it("bounds before decode and rejects noncanonical base64 and duplicate JSON keys", () => {
    expect(config.indexOf("encoded.size() >")).toBeLessThan(config.indexOf("base::Base64UrlDecode("));
    expect(config).toContain("decoded.size() > kMaxConfigBytes");
    expect(config).toContain("Base64UrlDecodePolicy::DISALLOW_PADDING");
    expect(config).toContain("if (reencoded != encoded)");
    expect(config).toContain("if (decoded != canonical)");
    expect(config).toContain('root->FindInt("schemaVersion").value_or(0) != 1');
    expect(config).toContain("root->size() != (override_requested ? 5u : 4u)");
  });

  it("requires typed profile/launch identities and only two explicit modes", () => {
    expect(config).toContain('root->FindString("profileId")');
    expect(config).toContain('root->FindString("launchId")');
    expect(config).toContain("!IsUuidV4(*profile_id)");
    expect(config).toContain("!IsUuidV4(*launch_id)");
    expect(config).toContain("value[14] != '4'");
    expect(config).toContain('std::string_view("89ab")');
    expect(config).toContain('*mode == "timezone-only"');
    expect(config).toContain('*mode != "native-control"');
  });

  it("rejects contradictory aliases and does not rescue invalid public input", () => {
    expect(config).toContain("command_line.HasSwitch(kConfigSwitch)");
    expect(config).toContain("? kConfigSwitch : kLegacySwitch");
    expect(config).toContain("encoded != command_line.GetSwitchValueASCII(kLegacySwitch)");
    expect(config).not.toMatch(/selected\s*=\s*kLegacySwitch;/);
  });

  it("validates ICU system identities rather than accepting loose GMT offsets", () => {
    expect(config).toContain("icu::TimeZone::getCanonicalID(");
    expect(config).toContain("U_FAILURE(status) || !is_system_id");
    expect(config).toContain('icu::UnicodeString("Etc/Unknown"');
    expect(config).toContain("canonical_id.toUTF8String(canonical_timezone_)");
    expect(config).toContain("value.size() > 128");
    expect(config).not.toContain("icu::TimeZone::adoptDefault");
  });

  it("binds bounded Java/native receipts to the same SHA-256 input without logging the payload", () => {
    expect(config).toContain("base::HexEncodeLower(crypto::hash::Sha256(decoded))");
    expect(application).toContain('MessageDigest.getInstance("SHA-256").digest(payload)');
    expect(application).toContain("frozen=1 input_sha256=%s pid=%d");
    expect(timezone).toContain("applied=1 input_sha256=");
    expect(timezone).toContain("android_config.config_sha256()");
    expect(timezone).toContain("base::GetCurrentProcId()");
    expect(application).not.toMatch(/Log\.[iwed]\([^;]*(mEncoded|payload|json|inputBytes)/s);
  });

  it("fails closed before browser main parts and before renderer early returns", () => {
    expect(client).toContain("CHECK(!blink::AgentBrowserAndroidTimezoneConfig::Get().startup_invalid());");
    expect(timezone).toContain("CHECK(!config.startup_invalid());");
    expect(timezone).toContain("if (config.requested())");
    expect(timezone).toContain("instance();  // Apply before any early return or Window/Worker context.");
    expect(section(TIMEZONE)).toMatch(/void TimeZoneController::Init\(\) \{[\s\S]*CHECK\(!config\.startup_invalid\(\)\)[\s\S]*kTopChromeWebUI/);
  });

  it("sets ICU/V8 natively, prevents re-detection and freezes mutable override paths", () => {
    expect(timezone).toContain("CHECK(SetIcuTimeZoneAndNotifyV8(timezone_id));");
    expect(timezone).toContain("override_timezone_id_ = timezone_id;");
    expect(timezone).toContain("v8::Isolate::TimeZoneDetection::kSkip");
    expect(timezone.match(/CHECK\(!AgentBrowserAndroidTimezoneConfig::Get\(\)\.timezone_only\(\)\);/g)).toHaveLength(2);
    expect(timezone).not.toContain("kRedetect");
    expect(timezone).not.toMatch(/TZ\b|tzset|TimeZone\.setDefault|EvaluateScript/);
  });

  it("keeps explicit native-control receipts separate from applied overrides", () => {
    expect(timezone).toContain("if (android_config.native_control())");
    expect(timezone).toContain("applied=0 mode=native-control input_sha256=");
    expect(config).toContain('valid_ && mode_ == "native-control"');
  });

  it("forwards only the three timezone protocol switches to renderer children", () => {
    expect(client).toContain("switches::kRendererProcess");
    expect(client).toContain("kConfigSwitch");
    expect(client).toContain("kLegacySwitch");
    expect(client).toContain("kRequiredSwitch");
    expect(client).toContain("kTimezoneSwitches);");
    expect(client).not.toMatch(/kGpuProcess|kUtilityProcess|fingerprint-fonts-dir/);
  });

  it("initializes frozen argv before parent Application/library access and cannot repair late input", () => {
    expect(application.indexOf("freezeBeforeNative(base);")).toBeLessThan(application.indexOf("super.attachBaseContext(base);"));
    expect(application).toContain("CommandLine.isInitialized() || !mEncoded.isEmpty()");
    expect(application).toContain("ABS_TIMEZONE_COMMAND_LINE_ALREADY_INITIALIZED");
    expect(application).toContain("UUID.randomUUID()");
    expect(application).toContain("CommandLine.init(new String[]");
    expect(application).toContain("verifyFrozenCommandLine();  // Never repair or replace");
    expect(application).not.toMatch(/initFromFile|appendSwitch|TimeZone\.setDefault|setenv|Math\.random/);
  });

  it("uses a bounded immutable APK asset and a stable isolated profile suffix", () => {
    expect(application).toContain('ASSET = "agent_browser_timezone_fixture.json"');
    expect(application).toContain("bytes.size() + length > 2048");
    expect(application).toContain("ABS_TIMEZONE_ASSET_NOT_CANONICAL_JSON");
    expect(application).toContain('return "abs_timezone_" + mProfileId.replace("-", "")');
    expect(application).not.toMatch(/getData\(|getStringExtra|openFileInput|FileInputStream|SharedPreferences/);
    expect(section(`${JAVA}ContentShellApplication.java`)).toContain("getPrivateDataDirectorySuffix()");
  });

  it("rejects initial and late Intent command-line injection", () => {
    expect(activity).toContain("intent.hasExtra(COMMAND_LINE_ARGS_KEY)");
    expect(activity).toContain("ABS_TIMEZONE_INTENT_COMMAND_LINE_REJECTED");
    expect(activity).toContain("validateStartupIntent(getIntent());");
    expect(activity).toContain("validateStartupIntent(intent);");
    expect(activity).not.toContain("appendSwitch");
  });

  it("defines an opt-in test-only native APK without changing the existing WebView app", () => {
    expect(gn).toContain('agent_browser_timezone_fixture = ""');
    expect(gn).toContain('if (agent_browser_timezone_fixture != "")');
    expect(gn).toContain('content_shell_apk_tmpl("agent_browser_timezone_apk")');
    expect(gn).toContain("manifest_package=com.ahoo.abs.android.native_timezone.preview");
    expect(gn).toContain('shared_libraries = [ ":libcontent_shell_content_view" ]');
    expect(gn).toContain("assert(v8_enable_i18n_support");
    expect(gn).not.toMatch(/^\s*command_line_flags_file\s*=/m);
    expect(patch).not.toContain("+++ b/mobile/android/app/");
  });

  it.each(["native-control", "new-york", "shanghai"])("packages a canonical synthetic %s fixture", (name) => {
    const file = `content/shell/android/shell_apk/timezone_fixtures/${name}.json`;
    const json = additions(file).trim();
    expect(json).not.toBe("");
    const value = JSON.parse(json);
    const keys = Object.keys(value).sort();
    expect(json).toBe(JSON.stringify(value, keys));
    expect(value.profileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(value.schemaVersion).toBe(1);
    expect(value.mode).toBe(name === "native-control" ? "native-control" : "timezone-only");
    if (name === "native-control") expect(value.timezone).toBeUndefined();
    else expect(value.timezone).toBe(name === "new-york" ? "America/New_York" : "Asia/Shanghai");
  });

  it("adds actual C++ negative/snapshot tests and direct GN dependencies for the server to run", () => {
    const browserTests = additions("content/shell/browser/agent_browser_android_timezone_browsertest.cc");
    expect(browserTests).toContain("CopiesExactPayloadOnlyToRendererCommandLines");
    expect(browserTests).toContain("NativeWindowAndRecreatedDedicatedWorkers");
    expect(browserTests).toContain("client->AppendExtraCommandLineSwitches(&child, 0)");
    expect(browserTests).toContain("switches::kGpuProcess");
    expect(browserTests).toContain("worker.terminate()");
    expect(browserTests).toContain("new Date('2026-07-15T12:00:00Z').getTimezoneOffset()");
    expect(additions("content/test/BUILD.gn")).toContain("agent_browser_android_timezone_browsertest.cc");
    const tests = additions("third_party/blink/common/agent_browser_android_timezone_config_unittest.cc");
    for (const name of ["AbsentIsNotAnOverride", "MissingRequiredPayloadIsInvalid", "NewYorkUsesIcuSystemIdentity",
      "NativeControlHasNoTimezone", "InvalidInputsNeverBecomeNativeControl", "CorruptPublicNeverFallsBackToLegacy",
      "LegacyOnlyStillUsesTheSameContract", "OversizedOrPaddedEncodingIsRejected",
      "V8TimezoneRedetectionFlagsAreNotAllowed", "ParsedSnapshotDoesNotFollowLaterCommandChanges"]) {
      expect(tests).toContain(`TEST(AgentBrowserAndroidTimezoneConfigTest, ${name})`);
    }
    expect(additions("third_party/blink/common/BUILD.gn")).toContain('"agent_browser_android_timezone_config_unittest.cc"');
    expect(additions("third_party/blink/public/common/BUILD.gn")).toContain('"//crypto"');
    expect(additions("third_party/blink/public/common/BUILD.gn")).toContain('"//third_party/icu"');
    expect(additions("content/shell/BUILD.gn")).toContain('"//third_party/blink/public/common"');
  });

  it("uses the same required 2026 winter/summer inputs in the native test and every fixture realm", () => {
    const probe = fs.readFileSync(path.join(ROOT, "mobile/android/native-kernel-tests/realm-probe.js"), "utf8");
    const model = fs.readFileSync(path.join(ROOT, "mobile/android/native-kernel-tests/model.mjs"), "utf8");
    for (const instant of ["2026-01-15T12:00:00.000Z", "2026-07-15T12:00:00.000Z"]) {
      expect(probe).toContain(instant);
      expect(model).toContain(instant);
    }
    expect(probe).not.toContain("2024-");
    expect(model).not.toContain("2024-");
  });

  it("binds the appended patch and final sources to their exact manifests", () => {
    expect(read("PATCHSET.sha256")).toContain(`${sha(patch)}  ${PATCH}`);
    expect(read("PATCHSET.sha256")).toContain(`${sha(read("PATCHED_SOURCE.sha256"))}  PATCHED_SOURCE.sha256`);
    const sources = new Map(read("PATCHED_SOURCE.sha256").trim().split(/\r?\n/)
      .map((line) => { const [hash, file] = line.split("  "); return [file, hash]; }));
    for (const file of [CONFIG, `${JAVA}AgentBrowserTimezoneApplication.java`, `${JAVA}AgentBrowserTimezoneActivity.java`]) {
      expect(sources.get(file), file).toBe(sha(additions(file) + "\n"));
    }
  });
});
