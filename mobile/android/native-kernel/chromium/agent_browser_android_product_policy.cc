// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#include "content/shell/android/agent_browser_product/chromium/agent_browser_android_product_policy.h"

#include <algorithm>
#include <initializer_list>
#include <string>
#include <string_view>
#include <utility>

#include "base/android/jni_android.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/containers/flat_map.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/synchronization/lock.h"
#include "base/task/bind_post_task.h"
#include "base/time/time.h"
#include "content/public/browser/browser_thread.h"
#include "jni_headers/content/shell/agent_browser_product_jni_headers/MediaPermissionBridge_jni.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "net/base/net_errors.h"
#include "net/base/proxy_server.h"
#include "net/proxy_resolution/proxy_config.h"
#include "net/proxy_resolution/proxy_config_with_annotation.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "third_party/blink/public/common/agent_browser_android_timezone_config.h"
#include "third_party/blink/public/common/loader/url_loader_throttle.h"
#include "url/gurl.h"

namespace content {
namespace {

constexpr char kProxyServerSwitch[] = "proxy-server";
constexpr char kProxyBypassListSwitch[] = "proxy-bypass-list";
constexpr char kRequiredProxyBypassList[] = "<-loopback>";

constexpr net::NetworkTrafficAnnotationTag kProductProxyTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("agent_browser_android_product_proxy", R"(
      semantics {
        sender: "Agent Browser Android Product Proxy"
        description:
          "Routes browser requests through the fixed proxy endpoint selected in "
          "the Android product profile. There is no PAC, system proxy, bypass, "
          "or direct-connection alternative in this configuration."
        trigger:
          "A network request in an Android product-profile browser process."
        data:
          "The proxy endpoint configuration, without authentication credentials. "
          "Individual requests have their own traffic annotations."
        destination: OTHER
        destination_other: "The proxy server selected in the product profile."
      }
      policy {
        cookies_allowed: NO
        setting:
          "The proxy is selected in the product profile before browser startup "
          "and cannot be changed during that browser process's lifetime."
        policy_exception_justification:
          "This content_shell-based product has no Chrome enterprise policy "
          "service; the product profile supplies the mandatory proxy."
      })");

constexpr net::NetworkTrafficAnnotationTag kProductDirectTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("agent_browser_android_product_direct", R"(
      semantics {
        sender: "Agent Browser Android Product Direct"
        description:
          "Connects browser requests directly using the device network and "
          "normal hostname resolution, as explicitly selected in the Android "
          "product profile. No product proxy or proxy DNS protection applies."
        trigger:
          "A network request in an explicitly direct Android product profile."
        data:
          "The explicit direct routing selection, without proxy credentials. "
          "Individual requests have their own traffic annotations."
        destination: OTHER
        destination_other: "The destination selected by each browser request."
      }
      policy {
        cookies_allowed: NO
        setting:
          "Direct routing is selected in the product profile before browser "
          "startup and cannot change during that browser process's lifetime."
        policy_exception_justification:
          "This content_shell-based product has no Chrome enterprise policy "
          "service; the user explicitly selected an unproxied product profile."
      })");

class ProductPreflightThrottle final : public blink::URLLoaderThrottle {
 public:
  void WillStartRequest(network::ResourceRequest* request, bool*) override {
    CheckUrl(request->url);
  }

  void WillRedirectRequest(
      net::RedirectInfo* redirect_info,
      const network::mojom::URLResponseHead&,
      bool*,
      network::HttpRequestHeadersUpdateParams*) override {
    CheckUrl(redirect_info->new_url);
  }

 private:
  void CheckUrl(const GURL& url) {
    if (!IsAgentBrowserProductPreflightUrlAllowed(url)) {
      delegate_->CancelWithError(net::ERR_BLOCKED_BY_ADMINISTRATOR,
                                 "ABS_PRODUCT_PREFLIGHT_ONLY");
    }
  }
};

}  // namespace

bool IsAgentBrowserProductPreflight() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch(
      kAgentBrowserProductPreflightSwitch);
}

void VerifyAgentBrowserProductPreflightStartup() {
  const auto& command = *base::CommandLine::ForCurrentProcess();
  const bool product_profile =
      command.HasSwitch(kAgentBrowserProductProfileSwitch);
  const bool product_network_mode =
      command.HasSwitch(kAgentBrowserProductNetworkModeSwitch);
  if (!IsAgentBrowserProductPreflight() && !product_profile &&
      !product_network_mode)
    return;
  const auto& timezone = blink::AgentBrowserAndroidTimezoneConfig::Get();
  CHECK(timezone.valid() && timezone.timezone_only());
  CHECK(command.HasSwitch(
      blink::AgentBrowserAndroidTimezoneConfig::kRequiredSwitch));
  for (const char* forbidden : {"roxy-fingerprint-config", "js-flags",
                                "user-data-dir", "content-shell-user-data-dir",
                                "no-sandbox",
                                "disable-web-security",
                                "ignore-certificate-errors", "run-web-tests",
                                "remote-debugging-port", "remote-debugging-pipe",
                                "remote-debugging-socket-name"}) {
    CHECK(!command.HasSwitch(forbidden));
  }
  // Keep preflight-only startup unchanged. Validate the same frozen network
  // selection here and at every NetworkContext; direct also requires the marker.
  if (product_profile || product_network_mode)
    CHECK(ParseAgentBrowserProductNetworkConfig(command));
}

bool ParseAgentBrowserProductProxyConfig(const base::CommandLine& command,
                                       net::ProxyConfig* out_config) {
  if (!command.HasSwitch(kProxyServerSwitch) ||
      command.GetSwitchValueUTF8(kProxyBypassListSwitch) !=
          kRequiredProxyBypassList) {
    return false;
  }
  // Reject every other proxy switch, including PAC, auto-detect, no-proxy, and
  // system-resolver switches, rather than silently ignoring a competing source.
  for (const auto& entry : command.GetSwitches()) {
    if (entry.first.find("proxy") != std::string::npos &&
        entry.first != kProxyServerSwitch &&
        entry.first != kProxyBypassListSwitch) {
      return false;
    }
  }

  const std::string endpoint = command.GetSwitchValueUTF8(kProxyServerSwitch);
  if (std::any_of(endpoint.begin(), endpoint.end(), [](unsigned char c) {
        return c <= 0x20 || c >= 0x7f;
      })) {
    return false;
  }
  const std::string_view uri(endpoint);
  const size_t scheme_end = uri.find("://");
  if (scheme_end == std::string_view::npos)
    return false;
  const std::string_view scheme_name = uri.substr(0, scheme_end);
  net::ProxyServer::Scheme scheme;
  if (base::EqualsCaseInsensitiveASCII(scheme_name, "http")) {
    scheme = net::ProxyServer::SCHEME_HTTP;
  } else if (base::EqualsCaseInsensitiveASCII(scheme_name, "https")) {
    scheme = net::ProxyServer::SCHEME_HTTPS;
  } else if (base::EqualsCaseInsensitiveASCII(scheme_name, "socks5")) {
    scheme = net::ProxyServer::SCHEME_SOCKS5;
  } else {
    return false;
  }

  // Accept an authority only: not credentials, a URL path, a rule/list, an
  // encoded delimiter, or a bracketed multi-proxy chain. Require an explicit
  // numeric port so an omitted/empty port cannot turn into a default endpoint.
  const std::string_view authority = uri.substr(scheme_end + 3);
  if (authority.find_first_of("/\\@?#,;=%") != std::string_view::npos)
    return false;
  const size_t port_separator = authority.rfind(':');
  if (port_separator == std::string_view::npos)
    return false;
  const std::string_view host = authority.substr(0, port_separator);
  const std::string_view port = authority.substr(port_separator + 1);
  if (host.empty() || port.empty() ||
      port.find_first_not_of("0123456789") != std::string_view::npos) {
    return false;
  }
  if (host.front() == '[') {
    if (host.back() != ']')
      return false;
  } else if (host.find_first_of("[]:") != std::string_view::npos) {
    return false;
  }
  int port_number = 0;
  if (!base::StringToInt(port, &port_number) || port_number < 1 ||
      port_number > 65535) {
    return false;
  }
  const net::ProxyServer server =
      net::ProxyServer::FromSchemeHostAndPort(scheme, host, port);
  if (!server.is_valid())
    return false;

  net::ProxyConfig config;
  auto& rules = config.proxy_rules();
  rules.type = net::ProxyConfig::ProxyRules::Type::PROXY_LIST;
  rules.single_proxies.SetSingleProxyServer(server);
  rules.bypass_rules.ParseFromString(kRequiredProxyBypassList);
  // A single PROXY_LIST applies equally to HTTP, HTTPS, WS/WSS and other
  // schemes. No alternative (particularly DIRECT) is appended on failure.
  if (out_config)
    *out_config = std::move(config);
  return true;
}

bool ParseAgentBrowserProductNetworkConfig(
    const base::CommandLine& command,
    net::ProxyConfig* out_config,
    AgentBrowserProductNetworkMode* out_mode) {
  if (!command.HasSwitch(kAgentBrowserProductProfileSwitch))
    return false;
  net::ProxyConfig config;
  AgentBrowserProductNetworkMode mode = AgentBrowserProductNetworkMode::kProxy;
  if (!command.HasSwitch(kAgentBrowserProductNetworkModeSwitch)) {
    // Legacy means proxy, never an implicit direct fallback.
    if (!ParseAgentBrowserProductProxyConfig(command, &config))
      return false;
  } else {
    if (command.GetSwitchValueUTF8(kAgentBrowserProductNetworkModeSwitch) !=
        "direct") {
      return false;
    }
    for (const auto& entry : command.GetSwitches()) {
      if (entry.first.find("proxy") != std::string::npos ||
          entry.first == "host-resolver-rules" || entry.first == "host-rules" ||
          entry.first == "agent-browser-local-dns-policy") {
        return false;
      }
    }
    config = net::ProxyConfig::CreateDirect();
    mode = AgentBrowserProductNetworkMode::kDirect;
  }
  if (out_config)
    *out_config = std::move(config);
  if (out_mode)
    *out_mode = mode;
  return true;
}

void ConfigureAgentBrowserProductNetworkContextParams(
    network::mojom::NetworkContextParams* params) {
  const auto& command = *base::CommandLine::ForCurrentProcess();
  if (!command.HasSwitch(kAgentBrowserProductProfileSwitch) &&
      !command.HasSwitch(kAgentBrowserProductNetworkModeSwitch)) {
    return;
  }
  CHECK(params);
  net::ProxyConfig config;
  AgentBrowserProductNetworkMode mode = AgentBrowserProductNetworkMode::kProxy;
  CHECK(ParseAgentBrowserProductNetworkConfig(command, &config, &mode));
  // Both modes have one immutable source. Never replace a foreign owner or
  // install an update channel that could restore system/alternative routing.
  CHECK(!params->initial_proxy_config);
  CHECK(!params->proxy_config_client_receiver.is_valid());
  CHECK(!params->proxy_config_poller_client.is_valid());
  CHECK(!params->initial_custom_proxy_config);
  CHECK(!params->custom_proxy_config_client_receiver.is_valid());
  if (mode == AgentBrowserProductNetworkMode::kDirect) {
    params->initial_proxy_config =
        net::ProxyConfigWithAnnotation(config, kProductDirectTrafficAnnotation);
    LOG(INFO) << "ABS_ANDROID_NETWORK_V1 mode=direct configured=1";
    return;
  }
  params->initial_proxy_config =
      net::ProxyConfigWithAnnotation(config, kProductProxyTrafficAnnotation);
  LOG(INFO) << "ABS_ANDROID_PROXY_V1 configured=1";
}

bool IsAgentBrowserProductPreflightUrlAllowed(const GURL& url) {
  return url.is_valid() && (url.IsAboutBlank() || url.SchemeIsBlob());
}

std::unique_ptr<blink::URLLoaderThrottle>
CreateAgentBrowserProductPreflightThrottle() {
  CHECK(IsAgentBrowserProductPreflight());
  return std::make_unique<ProductPreflightThrottle>();
}

namespace {

// Bounded wait while the user answers the system permission dialog. The OS
// permission store is the single source of truth; the native side re-reads it
// over JNI instead of keeping a Java-to-native callback channel.
constexpr base::TimeDelta kMediaPermissionPollInterval = base::Milliseconds(500);
constexpr int kMediaPermissionPollMaxAttempts = 240;  // 120s ceiling

struct MediaPermissionWait {
  bool audio = false;
  bool video = false;
  int attempts_left = 0;
  base::OnceCallback<void(bool, bool)> callback;
};

base::Lock& MediaPermissionLock() {
  static base::NoDestructor<base::Lock> lock;
  return *lock;
}

long g_next_media_permission_id = 1;

base::flat_map<long, MediaPermissionWait>& PendingMediaPermissions() {
  static base::NoDestructor<base::flat_map<long, MediaPermissionWait>> map;
  return *map;
}

bool OsCaptureGrantedViaJava(bool audio, bool video) {
  JNIEnv* env = base::android::AttachCurrentThread();
  return Java_MediaPermissionBridge_isCaptureGranted(env, audio, video);
}

void PollMediaPermissionResult(long callback_id) {
  bool granted_now = false;
  bool attempts_left = false;
  base::OnceCallback<void(bool, bool)> callback;
  {
    base::AutoLock lock(MediaPermissionLock());
    auto it = PendingMediaPermissions().find(callback_id);
    if (it == PendingMediaPermissions().end()) return;
    granted_now = OsCaptureGrantedViaJava(it->second.audio, it->second.video);
    it->second.attempts_left -= 1;
    attempts_left = it->second.attempts_left > 0;
    if (granted_now || !attempts_left) {
      callback = std::move(it->second.callback);
      PendingMediaPermissions().erase(it);
    }
  }
  if (!callback) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&PollMediaPermissionResult, callback_id),
        kMediaPermissionPollInterval);
    return;
  }
  std::move(callback).Run(granted_now, granted_now);
}

}  // namespace

void AgentBrowserRequestAndroidMediaPermissions(
    bool audio,
    bool video,
    base::OnceCallback<void(bool audio_granted, bool video_granted)> callback) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  long callback_id = 0;
  bool granted_now = OsCaptureGrantedViaJava(audio, video);
  {
    base::AutoLock lock(MediaPermissionLock());
    callback_id = g_next_media_permission_id++;
    PendingMediaPermissions()[callback_id] = {audio, video,
                                              kMediaPermissionPollMaxAttempts,
                                              std::move(callback)};
  }
  if (granted_now) {
    base::AutoLock lock(MediaPermissionLock());
    auto it = PendingMediaPermissions().find(callback_id);
    if (it != PendingMediaPermissions().end()) {
      base::OnceCallback<void(bool, bool)> pending_callback =
          std::move(it->second.callback);
      PendingMediaPermissions().erase(it);
      std::move(pending_callback).Run(true, true);
      return;
    }
  }
  // Surface the system dialog once; the bounded poll below completes the
  // request when (and only when) the user grants it.
  JNIEnv* env = base::android::AttachCurrentThread();
  Java_MediaPermissionBridge_firePermissionDialog(env, audio, video);
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&PollMediaPermissionResult, callback_id),
      kMediaPermissionPollInterval);
}

}  // namespace content
