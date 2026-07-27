// Copyright 2026 The RoxyLite Authors
// Use of this source code is governed by a BSD-style license.

#ifndef THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_FINGERPRINT_CONFIG_H_
#define THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_FINGERPRINT_CONFIG_H_

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "base/base64url.h"
#include "base/command_line.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"

namespace blink {

// Process-wide, immutable identity passed by roxy-lite-cloak-oss. Keeping the
// parser in Blink public/common lets the browser network stack, window
// Navigator, and WorkerNavigator use exactly the same values.
class RoxyFingerprintConfig {
 public:
  struct Screen {
    int width = 0;
    int height = 0;
    int avail_width = 0;
    int avail_height = 0;
    int color_depth = 0;
    int pixel_depth = 0;
    double device_pixel_ratio = 0;
  };

  static const RoxyFingerprintConfig& Get() {
    static const base::NoDestructor<RoxyFingerprintConfig> config;
    return *config;
  }

  bool enabled() const { return enabled_; }
  int seed() const { return seed_; }
  const std::string& platform() const { return platform_; }
  const std::string& platform_version() const { return platform_version_; }
  const std::string& user_agent() const { return user_agent_; }
  const std::string& app_version() const { return app_version_; }
  const std::vector<std::string>& languages() const { return languages_; }
  int hardware_concurrency() const { return hardware_concurrency_; }
  int device_memory() const { return device_memory_; }
  int max_touch_points() const { return max_touch_points_; }
  const Screen& screen() const { return screen_; }
  bool canvas_noise_enabled() const { return canvas_noise_enabled_; }
  uint64_t canvas_noise_seed() const { return canvas_noise_seed_; }
  bool audio_noise_enabled() const { return audio_noise_enabled_; }
  uint64_t audio_noise_seed() const { return audio_noise_seed_; }
  double audio_noise_amplitude() const { return audio_noise_amplitude_; }
  const std::string& webgl_vendor() const { return webgl_vendor_; }
  const std::string& webgl_renderer() const { return webgl_renderer_; }
  const std::string& timezone() const { return timezone_; }

  std::string accept_languages() const {
    std::string result;
    for (const std::string& language : languages_) {
      if (!result.empty())
        result.append(",");
      result.append(language);
    }
    return result;
  }

  UserAgentMetadata GetUserAgentMetadata(bool low_entropy_only) const {
    UserAgentMetadata metadata;
    if (!enabled_)
      return metadata;

    const std::string full_version = ChromeVersion();
    const std::string major_version =
        full_version.substr(0, full_version.find('.'));
    metadata.brand_version_list = {
        {"Chromium", major_version},
        {"Google Chrome", major_version},
        {"Not_A Brand", "99"},
    };
    metadata.mobile = false;
    metadata.platform = platform_ == "Win32" ? "Windows" : "macOS";
    if (low_entropy_only)
      return metadata;

    metadata.brand_full_version_list = {
        {"Chromium", full_version},
        {"Google Chrome", full_version},
        {"Not_A Brand", "99.0.0.0"},
    };
    metadata.full_version = full_version;
    metadata.platform_version = platform_version_;
    metadata.architecture = "x86";
    metadata.bitness = "64";
    metadata.model = "";
    metadata.wow64 = false;
    metadata.form_factors = {kDesktopFormFactor};
    return metadata;
  }

 private:
  friend class base::NoDestructor<RoxyFingerprintConfig>;

  RoxyFingerprintConfig() {
    constexpr char kSwitch[] = "roxy-fingerprint-config";
    constexpr size_t kMaxConfigBytes = 64 * 1024;
    const base::CommandLine* command_line =
        base::CommandLine::ForCurrentProcess();
    if (!command_line->HasSwitch(kSwitch))
      return;

    std::string decoded;
    const std::string encoded = command_line->GetSwitchValueASCII(kSwitch);
    if (!base::Base64UrlDecode(encoded,
                               base::Base64UrlDecodePolicy::IGNORE_PADDING,
                               &decoded) ||
        decoded.size() > kMaxConfigBytes) {
      return;
    }
    auto root = base::JSONReader::ReadDict(decoded);
    if (!root || root->FindInt("schemaVersion").value_or(0) != 1)
      return;

    seed_ = root->FindInt("seed").value_or(0);
    platform_ = ReadString(*root, "platform");
    platform_version_ = ReadString(*root, "platformVersion");
    user_agent_ = ReadString(*root, "userAgent");
    app_version_ = ReadString(*root, "appVersion");
    hardware_concurrency_ =
        root->FindInt("hardwareConcurrency").value_or(0);
    device_memory_ = root->FindInt("deviceMemory").value_or(0);
    max_touch_points_ = root->FindInt("maxTouchPoints").value_or(0);

    if (const base::Value::List* languages = root->FindList("languages")) {
      for (const base::Value& language : *languages) {
        if (language.is_string() && !language.GetString().empty())
          languages_.push_back(language.GetString());
      }
    }
    if (const base::Value::Dict* screen = root->FindDict("screen")) {
      screen_.width = screen->FindInt("width").value_or(0);
      screen_.height = screen->FindInt("height").value_or(0);
      screen_.avail_width = screen->FindInt("availWidth").value_or(0);
      screen_.avail_height = screen->FindInt("availHeight").value_or(0);
      screen_.color_depth = screen->FindInt("colorDepth").value_or(0);
      screen_.pixel_depth = screen->FindInt("pixelDepth").value_or(0);
      screen_.device_pixel_ratio =
          screen->FindDouble("devicePixelRatio").value_or(0);
    }
    if (const base::Value::Dict* webgl = root->FindDict("webgl")) {
      webgl_vendor_ = ReadString(*webgl, "vendor");
      webgl_renderer_ = ReadString(*webgl, "renderer");
    }
    if (const base::Value::Dict* canvas = root->FindDict("canvas")) {
      canvas_noise_enabled_ = canvas->FindBool("enabled").value_or(false);
      canvas_noise_seed_ = HashSeed(ReadString(*canvas, "seed"));
    }
    if (const base::Value::Dict* audio = root->FindDict("audio")) {
      audio_noise_enabled_ = audio->FindBool("enabled").value_or(false);
      audio_noise_seed_ = HashSeed(ReadString(*audio, "seed"));
      audio_noise_amplitude_ =
          audio->FindDouble("amplitude").value_or(0.0);
    }
    if (const std::string* timezone = root->FindString("timezone"))
      timezone_ = *timezone;

    enabled_ = seed_ > 0 &&
               (platform_ == "Win32" || platform_ == "MacIntel") &&
               !user_agent_.empty() && !languages_.empty() &&
               hardware_concurrency_ > 0 && device_memory_ > 0;
  }

  static std::string ReadString(const base::Value::Dict& dict,
                                std::string_view key) {
    const std::string* value = dict.FindString(key);
    return value ? *value : std::string();
  }

  static uint64_t HashSeed(std::string_view value) {
    uint64_t hash = 1469598103934665603ULL;
    for (const char character : value) {
      hash ^= static_cast<uint8_t>(character);
      hash *= 1099511628211ULL;
    }
    return hash;
  }

  std::string ChromeVersion() const {
    const size_t start = user_agent_.find("Chrome/");
    if (start == std::string::npos)
      return "149.0.0.0";
    const size_t value_start = start + 7;
    const size_t end = user_agent_.find(' ', value_start);
    return user_agent_.substr(value_start, end - value_start);
  }

  bool enabled_ = false;
  int seed_ = 0;
  std::string platform_;
  std::string platform_version_;
  std::string user_agent_;
  std::string app_version_;
  std::vector<std::string> languages_;
  int hardware_concurrency_ = 0;
  int device_memory_ = 0;
  int max_touch_points_ = 0;
  Screen screen_;
  bool canvas_noise_enabled_ = false;
  uint64_t canvas_noise_seed_ = 0;
  bool audio_noise_enabled_ = false;
  uint64_t audio_noise_seed_ = 0;
  double audio_noise_amplitude_ = 0.0;
  std::string webgl_vendor_;
  std::string webgl_renderer_;
  std::string timezone_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_FINGERPRINT_CONFIG_H_
