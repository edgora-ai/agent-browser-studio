// Copyright 2026 The RoxyLite Authors
// Use of this source code is governed by a BSD-style license.

#ifndef THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_WEBRTC_REWRITER_H_
#define THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_WEBRTC_REWRITER_H_

#include <array>
#include <cctype>
#include <string>
#include <string_view>

#include "third_party/blink/public/common/roxy_fingerprint_config.h"

namespace blink {

inline bool IsRoxyPublicIpv4(std::string_view value) {
  std::array<int, 4> octets{};
  size_t part = 0;
  size_t index = 0;
  while (index < value.size() && part < octets.size()) {
    if (!std::isdigit(static_cast<unsigned char>(value[index])))
      return false;
    int octet = 0;
    size_t digits = 0;
    while (index < value.size() &&
           std::isdigit(static_cast<unsigned char>(value[index]))) {
      octet = octet * 10 + (value[index++] - '0');
      if (++digits > 3 || octet > 255)
        return false;
    }
    octets[part++] = octet;
    if (index == value.size())
      break;
    if (value[index++] != '.')
      return false;
  }
  if (index != value.size() || part != 4)
    return false;
  if (octets[0] == 0 || octets[0] == 10 || octets[0] == 127 ||
      octets[0] >= 224)
    return false;
  if (octets[0] == 169 && octets[1] == 254)
    return false;
  if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
    return false;
  if (octets[0] == 192 && octets[1] == 168)
    return false;
  return true;
}

inline std::string RewriteRoxyWebRtcPublicIps(std::string_view input) {
  const RoxyFingerprintConfig& config = RoxyFingerprintConfig::Get();
  if (!config.enabled() || config.webrtc_mode() != "altered" ||
      config.webrtc_public_ip().empty()) {
    return std::string(input);
  }

  std::string result;
  result.reserve(input.size());
  size_t cursor = 0;
  while (cursor < input.size()) {
    if (!std::isdigit(static_cast<unsigned char>(input[cursor]))) {
      result.push_back(input[cursor++]);
      continue;
    }
    const size_t start = cursor;
    while (cursor < input.size() &&
           (std::isdigit(static_cast<unsigned char>(input[cursor])) ||
            input[cursor] == '.')) {
      ++cursor;
    }
    const std::string_view token = input.substr(start, cursor - start);
    result.append(IsRoxyPublicIpv4(token) ? config.webrtc_public_ip()
                                         : std::string(token));
  }
  return result;
}

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_PUBLIC_COMMON_ROXY_WEBRTC_REWRITER_H_
