// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#include "content/shell/android/agent_browser_product/chromium/agent_browser_android_product_policy.h"

#include <initializer_list>

#include "base/check.h"
#include "base/command_line.h"
#include "net/base/net_errors.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "third_party/blink/public/common/agent_browser_android_timezone_config.h"
#include "third_party/blink/public/common/loader/url_loader_throttle.h"
#include "url/gurl.h"

namespace content {
namespace {

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
  if (!IsAgentBrowserProductPreflight())
    return;
  const auto& command = *base::CommandLine::ForCurrentProcess();
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
