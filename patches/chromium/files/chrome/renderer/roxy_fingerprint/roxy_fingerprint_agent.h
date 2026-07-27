// Copyright 2026 The RoxyLite Authors
// Use of this source code is governed by a BSD-style license.

#ifndef CHROME_RENDERER_ROXY_FINGERPRINT_ROXY_FINGERPRINT_AGENT_H_
#define CHROME_RENDERER_ROXY_FINGERPRINT_ROXY_FINGERPRINT_AGENT_H_

#include <string>

#include "content/public/renderer/render_frame_observer.h"

namespace content {
class RenderFrame;
}

// Installs the open Roxy fingerprint configuration before page scripts run.
// The browser manager passes a versioned JSON document through a base64url
// command-line switch, avoiding profile secrets and proprietary config formats.
class RoxyFingerprintAgent final : public content::RenderFrameObserver {
 public:
  static void MaybeCreate(content::RenderFrame* render_frame);

  RoxyFingerprintAgent(const RoxyFingerprintAgent&) = delete;
  RoxyFingerprintAgent& operator=(const RoxyFingerprintAgent&) = delete;

 private:
  RoxyFingerprintAgent(content::RenderFrame* render_frame,
                       std::string config_json);
  ~RoxyFingerprintAgent() override;

  void DidClearWindowObject() override;
  void OnDestruct() override;

  std::string BuildInjectionScript() const;

  const std::string config_json_;
};

#endif  // CHROME_RENDERER_ROXY_FINGERPRINT_ROXY_FINGERPRINT_AGENT_H_
