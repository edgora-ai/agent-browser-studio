// Copyright 2026 The RoxyLite Authors
// Use of this source code is governed by a BSD-style license.

#ifndef THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_FINGERPRINT_CONFIG_H_
#define THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_FINGERPRINT_CONFIG_H_

#include <cstdint>
#include <cctype>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base64url.h"
#include "base/command_line.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/values.h"
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

  struct RuntimeFont {
    std::string postscript_name;
    std::string full_name;
    std::string family;
    std::string style;
  };

  struct RuntimeMediaMapping {
    std::string synthetic_id;
    std::string actual_id;
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
  int64_t storage_quota_bytes() const { return storage_quota_bytes_; }
  const Screen& screen() const { return screen_; }
  bool canvas_noise_enabled() const { return canvas_noise_enabled_; }
  uint64_t canvas_noise_seed() const { return canvas_noise_seed_; }
  bool audio_noise_enabled() const { return audio_noise_enabled_; }
  uint64_t audio_noise_seed() const { return audio_noise_seed_; }
  double audio_noise_amplitude() const { return audio_noise_amplitude_; }
  const std::string& webrtc_mode() const { return webrtc_mode_; }
  const std::string& webrtc_public_ip() const { return webrtc_public_ip_; }
  const std::string& webgl_vendor() const { return webgl_vendor_; }
  const std::string& webgl_renderer() const { return webgl_renderer_; }
  const std::string& timezone() const { return timezone_; }
  const std::vector<std::string>& fonts() const { return fonts_; }
  const std::vector<RuntimeFont>& runtime_fonts() const {
    return runtime_fonts_;
  }
  const std::string& geolocation_mode() const { return geolocation_mode_; }
  double geolocation_latitude() const { return geolocation_latitude_; }
  double geolocation_longitude() const { return geolocation_longitude_; }
  double geolocation_accuracy() const { return geolocation_accuracy_; }
  bool media_devices_enabled() const { return media_devices_enabled_; }
  int media_audio_inputs() const { return media_audio_inputs_; }
  int media_video_inputs() const { return media_video_inputs_; }
  int media_audio_outputs() const { return media_audio_outputs_; }

  std::string StableToken(std::string_view name_space,
                          std::string_view scope) const {
    constexpr char kHex[] = "0123456789abcdef";
    std::string result;
    result.reserve(64);
    for (uint64_t block = 0; block < 4; ++block) {
      uint64_t hash = 1469598103934665603ULL ^
                      (static_cast<uint64_t>(seed_) << 32) ^
                      (0x9e3779b97f4a7c15ULL * (block + 1));
      for (const char character : name_space) {
        hash ^= static_cast<uint8_t>(character);
        hash *= 1099511628211ULL;
      }
      hash ^= 0xff;
      for (const char character : scope) {
        hash ^= static_cast<uint8_t>(character);
        hash *= 1099511628211ULL;
      }
      for (int shift = 60; shift >= 0; shift -= 4)
        result.push_back(kHex[(hash >> shift) & 0xf]);
    }
    return result;
  }

  bool IsFontAllowed(std::string_view family) const {
    if (!enabled_ || fonts_.empty())
      return true;
    const std::string normalized = LowerAscii(family);
    if (normalized == "serif" || normalized == "sans-serif" ||
        normalized == "monospace" || normalized == "cursive" ||
        normalized == "fantasy" || normalized == "system-ui" ||
        normalized.starts_with("ui-")) {
      return true;
    }
    for (const std::string& allowed : fonts_) {
      if (LowerAscii(allowed) == normalized)
        return true;
    }
    for (const RuntimeFont& runtime_font : runtime_fonts_) {
      if (LowerAscii(runtime_font.family) == normalized ||
          LowerAscii(runtime_font.full_name) == normalized ||
          LowerAscii(runtime_font.postscript_name) == normalized) {
        return true;
      }
    }
    return false;
  }

  // Called on the renderer main thread before the sandbox is engaged and
  // before Blink initializes its font manager. Runtime fonts are immutable
  // after that startup phase, so later reads do not require synchronization.
  static void RegisterRuntimeFont(RuntimeFont font) {
    RoxyFingerprintConfig& config =
        const_cast<RoxyFingerprintConfig&>(Get());
    if (!config.enabled_ || font.family.empty() ||
        font.postscript_name.empty() || config.runtime_fonts_.size() >= 256) {
      return;
    }
    const std::string normalized_postscript =
        LowerAscii(font.postscript_name);
    for (const RuntimeFont& existing : config.runtime_fonts_) {
      if (LowerAscii(existing.postscript_name) == normalized_postscript)
        return;
    }
    config.runtime_fonts_.push_back(std::move(font));
  }

  // Media device identifiers are salted per origin by Chromium. Enumeration
  // records the synthetic-to-actual relationship on the renderer main thread
  // so exact constraints and track settings can use one consistent identity.
  static void RegisterRuntimeMediaMapping(std::string synthetic_id,
                                          std::string actual_id) {
    RoxyFingerprintConfig& config =
        const_cast<RoxyFingerprintConfig&>(Get());
    if (!config.enabled_ || synthetic_id.empty() || actual_id.empty())
      return;
    for (RuntimeMediaMapping& mapping : config.runtime_media_mappings_) {
      if (mapping.synthetic_id == synthetic_id) {
        mapping.actual_id = std::move(actual_id);
        return;
      }
    }
    if (config.runtime_media_mappings_.size() >= 512)
      return;
    config.runtime_media_mappings_.push_back(
        {std::move(synthetic_id), std::move(actual_id)});
  }

  std::string MapMediaConstraintToActual(std::string_view id) const {
    for (const RuntimeMediaMapping& mapping : runtime_media_mappings_) {
      if (mapping.synthetic_id == id)
        return mapping.actual_id;
    }
    return std::string(id);
  }

  std::string MapMediaConstraintToSynthetic(std::string_view id) const {
    for (const RuntimeMediaMapping& mapping : runtime_media_mappings_) {
      if (mapping.actual_id == id)
        return mapping.synthetic_id;
    }
    return std::string(id);
  }

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
    auto root = base::JSONReader::ReadDict(decoded, base::JSON_PARSE_RFC);
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
    storage_quota_bytes_ = static_cast<int64_t>(
        root->FindDouble("storageQuotaBytes").value_or(0));

    if (const base::ListValue* languages = root->FindList("languages")) {
      for (const base::Value& language : *languages) {
        if (language.is_string() && !language.GetString().empty())
          languages_.push_back(language.GetString());
      }
    }
    if (const base::DictValue* screen = root->FindDict("screen")) {
      screen_.width = screen->FindInt("width").value_or(0);
      screen_.height = screen->FindInt("height").value_or(0);
      screen_.avail_width = screen->FindInt("availWidth").value_or(0);
      screen_.avail_height = screen->FindInt("availHeight").value_or(0);
      screen_.color_depth = screen->FindInt("colorDepth").value_or(0);
      screen_.pixel_depth = screen->FindInt("pixelDepth").value_or(0);
      screen_.device_pixel_ratio =
          screen->FindDouble("devicePixelRatio").value_or(0);
    }
    if (const base::DictValue* webgl = root->FindDict("webgl")) {
      webgl_vendor_ = ReadString(*webgl, "vendor");
      webgl_renderer_ = ReadString(*webgl, "renderer");
    }
    if (const base::DictValue* canvas = root->FindDict("canvas")) {
      canvas_noise_enabled_ = canvas->FindBool("enabled").value_or(false);
      canvas_noise_seed_ = HashSeed(ReadString(*canvas, "seed"));
    }
    if (const base::DictValue* audio = root->FindDict("audio")) {
      audio_noise_enabled_ = audio->FindBool("enabled").value_or(false);
      audio_noise_seed_ = HashSeed(ReadString(*audio, "seed"));
      audio_noise_amplitude_ =
          audio->FindDouble("amplitude").value_or(0.0);
    }
    if (const base::DictValue* webrtc = root->FindDict("webrtc")) {
      webrtc_mode_ = ReadString(*webrtc, "mode");
      if (const std::string* public_ip = webrtc->FindString("publicIp"))
        webrtc_public_ip_ = *public_ip;
    }
    if (const std::string* timezone = root->FindString("timezone"))
      timezone_ = *timezone;
    if (const base::DictValue* geolocation =
            root->FindDict("geolocation")) {
      geolocation_mode_ = ReadString(*geolocation, "mode");
      if (geolocation_mode_ != "real" && geolocation_mode_ != "disable" &&
          geolocation_mode_ != "custom") {
        return;
      }
      if (geolocation_mode_ == "custom") {
        const std::optional<double> latitude =
            geolocation->FindDouble("latitude");
        const std::optional<double> longitude =
            geolocation->FindDouble("longitude");
        const std::optional<double> accuracy =
            geolocation->FindDouble("accuracy");
        if (!latitude || !longitude || !accuracy || *latitude < -90.0 ||
            *latitude > 90.0 || *longitude < -180.0 ||
            *longitude > 180.0 || *accuracy < 0.0 ||
            *accuracy > 100000.0) {
          return;
        }
        geolocation_latitude_ = *latitude;
        geolocation_longitude_ = *longitude;
        geolocation_accuracy_ = *accuracy;
      }
    }
    if (const base::ListValue* fonts = root->FindList("fonts")) {
      for (const base::Value& font : *fonts) {
        if (font.is_string() && !font.GetString().empty())
          fonts_.push_back(font.GetString());
      }
    }
    if (const base::DictValue* media_devices =
            root->FindDict("mediaDevices")) {
      media_devices_enabled_ =
          media_devices->FindBool("enabled").value_or(false);
      media_audio_inputs_ =
          media_devices->FindInt("audioInputs").value_or(0);
      media_video_inputs_ =
          media_devices->FindInt("videoInputs").value_or(0);
      media_audio_outputs_ =
          media_devices->FindInt("audioOutputs").value_or(0);
      if (media_audio_inputs_ < 0 || media_audio_inputs_ > 8 ||
          media_video_inputs_ < 0 || media_video_inputs_ > 8 ||
          media_audio_outputs_ < 0 || media_audio_outputs_ > 8) {
        return;
      }
    }

    enabled_ = seed_ > 0 &&
               (platform_ == "Win32" || platform_ == "MacIntel") &&
               !user_agent_.empty() && !languages_.empty() &&
               hardware_concurrency_ > 0 && device_memory_ > 0;
  }

  static std::string ReadString(const base::DictValue& dict,
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

  static std::string LowerAscii(std::string_view value) {
    std::string result(value);
    for (char& character : result) {
      character = static_cast<char>(
          std::tolower(static_cast<unsigned char>(character)));
    }
    return result;
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
  int64_t storage_quota_bytes_ = 0;
  Screen screen_;
  bool canvas_noise_enabled_ = false;
  uint64_t canvas_noise_seed_ = 0;
  bool audio_noise_enabled_ = false;
  uint64_t audio_noise_seed_ = 0;
  double audio_noise_amplitude_ = 0.0;
  std::string webrtc_mode_;
  std::string webrtc_public_ip_;
  std::string webgl_vendor_;
  std::string webgl_renderer_;
  std::string timezone_;
  std::vector<std::string> fonts_;
  std::vector<RuntimeFont> runtime_fonts_;
  std::vector<RuntimeMediaMapping> runtime_media_mappings_;
  std::string geolocation_mode_ = "real";
  double geolocation_latitude_ = 0.0;
  double geolocation_longitude_ = 0.0;
  double geolocation_accuracy_ = 0.0;
  bool media_devices_enabled_ = false;
  int media_audio_inputs_ = 0;
  int media_video_inputs_ = 0;
  int media_audio_outputs_ = 0;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_FINGERPRINT_CONFIG_H_
