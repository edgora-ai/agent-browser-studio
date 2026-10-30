// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#ifndef CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_
#define CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_

#include <memory>

class GURL;
namespace blink {
class URLLoaderThrottle;
}

namespace content {

inline constexpr char kAgentBrowserProductPreflightSwitch[] =
    "agent-browser-product-preflight";

bool IsAgentBrowserProductPreflight();
void VerifyAgentBrowserProductPreflightStartup();
bool IsAgentBrowserProductPreflightUrlAllowed(const GURL& url);

// Browser-initiated navigation/worker-script defense only, not complete egress confinement.
std::unique_ptr<blink::URLLoaderThrottle>
CreateAgentBrowserProductPreflightThrottle();

}  // namespace content

#endif  // CONTENT_SHELL_ANDROID_AGENT_BROWSER_PRODUCT_CHROMIUM_AGENT_BROWSER_ANDROID_PRODUCT_POLICY_H_
