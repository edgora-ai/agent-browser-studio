// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#ifndef CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_
#define CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_

#include <memory>

#include "base/functional/callback.h"
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
inline constexpr char kAgentBrowserProductNetworkModeSwitch[] =
    "agent-browser-product-network-mode";

enum class AgentBrowserProductNetworkMode { kProxy, kDirect };

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

// Requires the product marker. An absent mode switch selects the unchanged
// strict proxy parser; only the exact explicit value "direct" selects direct.
// Direct rejects proxy/DNS controls. Outputs are unchanged on failure.
bool ParseAgentBrowserProductNetworkConfig(
    const base::CommandLine& command,
    net::ProxyConfig* out_config = nullptr,
    AgentBrowserProductNetworkMode* out_mode = nullptr);

// No-op for ordinary content_shell without a product network-mode switch.
// Product mode CHECKs configuration and installs a fixed initial proxy/direct
// config, without config-update clients or a system configuration source.
void ConfigureAgentBrowserProductNetworkContextParams(
    network::mojom::NetworkContextParams* params);

// Browser-initiated navigation/worker-script defense only, not complete egress confinement.
std::unique_ptr<blink::URLLoaderThrottle>
CreateAgentBrowserProductPreflightThrottle();

// Routes one web media-capture permission request through the Android runtime
// permission dialog (RECORD_AUDIO/CAMERA) via MediaPermissionBridge. Runs the
// callback once with the per-type grant results; never persists per-origin
// decisions, so every web request pays one OS round trip. Must be called on
// the browser UI thread; the callback runs there too.
void AgentBrowserRequestAndroidMediaPermissions(
    bool audio,
    bool video,
    base::OnceCallback<void(bool audio_granted, bool video_granted)> callback);

}  // namespace content

#endif  // CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_
