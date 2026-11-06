// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#include "content/shell/android/agent_browser_product/chromium/agent_browser_android_product_policy.h"

#include <algorithm>
#include <initializer_list>
#include <string>
#include <string_view>
#include <utility>

#include "base/check.h"
#include "base/command_line.h"
#include "base/logging.h"
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
  if (!IsAgentBrowserProductPreflight() && !product_profile)
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
  // Keep preflight-only startup unchanged. Product browsing must also have its
  // complete fixed proxy validated before any NetworkContext can be created.
  if (product_profile)
    CHECK(ParseAgentBrowserProductProxyConfig(command));
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

void ConfigureAgentBrowserProductNetworkContextParams(
    network::mojom::NetworkContextParams* params) {
  const auto& command = *base::CommandLine::ForCurrentProcess();
  if (!command.HasSwitch(kAgentBrowserProductProfileSwitch))
    return;
  CHECK(params);
  net::ProxyConfig config;
  CHECK(ParseAgentBrowserProductProxyConfig(command, &config));
  // This product has one frozen source of proxy settings. Do not allow another
  // source to override it after startup or to restore system/direct routing.
  CHECK(!params->initial_proxy_config);
  CHECK(!params->proxy_config_client_receiver.is_valid());
  CHECK(!params->proxy_config_poller_client.is_valid());
  CHECK(!params->initial_custom_proxy_config);
  CHECK(!params->custom_proxy_config_client_receiver.is_valid());
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

}  // namespace content
