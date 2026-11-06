// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#ifndef CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_
#define CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_

#include <memory>

#include "services/network/public/mojom/network_context.mojom-forward.h"

class GURL;
namespace base {
class CommandLine;
}
namespace blink {
class URLLoaderThrottle;
}
namespace net {
class ProxyConfig;
}

namespace content {

inline constexpr char kAgentBrowserProductPreflightSwitch[] =
    "agent-browser-product-preflight";
inline constexpr char kAgentBrowserProductProfileSwitch[] =
    "agent-browser-product-profile";

bool IsAgentBrowserProductPreflight();
// Checks preflight and product-profile startup before network contexts exist.
void VerifyAgentBrowserProductPreflightStartup();
bool IsAgentBrowserProductPreflightUrlAllowed(const GURL& url);

// Validates one explicit HTTP/HTTPS/SOCKS5 host:port and exactly <-loopback>
// as the bypass list. No PAC, DIRECT, system, or proxy alternatives are accepted.
// This helper does not require the product-profile marker. On failure, leaves
// out_config unchanged; nullptr performs validation only.
bool ParseAgentBrowserProductProxyConfig(
    const base::CommandLine& command,
    net::ProxyConfig* out_config = nullptr);

// No-op for ordinary content_shell. Product-profile mode CHECKs configuration
// and installs a fixed initial proxy, without a config-update client.
void ConfigureAgentBrowserProductNetworkContextParams(
    network::mojom::NetworkContextParams* params);

// Browser-initiated navigation/worker-script defense only, not complete egress confinement.
std::unique_ptr<blink::URLLoaderThrottle>
CreateAgentBrowserProductPreflightThrottle();

}  // namespace content

#endif  // CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_
