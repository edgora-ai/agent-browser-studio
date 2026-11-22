// CONTROL_FLOW_ONLY: canonical ASCII test URLs, not Chromium URL parsing.
#ifndef STANDALONE_REPLACEMENTS_GURL_HOST_H_
#define STANDALONE_REPLACEMENTS_GURL_HOST_H_
#include <string>
#include <string_view>
#include <utility>

class GURL {
 public:
  explicit GURL(std::string text = {}) : text_(std::move(text)) {
    auto scheme_end = text_.find("://");
    if (scheme_end == std::string::npos) return;
    scheme_ = text_.substr(0, scheme_end);
    auto authority_start = scheme_end + 3;
    auto authority_end = text_.find_first_of("/?#", authority_start);
    auto authority = text_.substr(authority_start, authority_end - authority_start);
    auto user = authority.find('@');
    if (user != std::string::npos) {
      username_ = true;
      password_ = authority.substr(0, user).find(':') != std::string::npos;
      authority.erase(0, user + 1);
    }
    auto port = authority.find(':');
    host_ = authority.substr(0, port);
    if (port != std::string::npos) port_ = std::stoi(authority.substr(port + 1));
    auto end = text_.find_first_of("?#", authority_end);
    path_ = authority_end == std::string::npos ? "/" : text_.substr(authority_end, end - authority_end);
    if (path_.empty() || path_[0] != '/') path_ = "/";
    valid_ = !host_.empty();
  }
  bool is_valid() const { return valid_; }
  bool SchemeIs(std::string_view value) const { return scheme_ == value; }
  bool has_host() const { return !host_.empty(); }
  bool has_username() const { return username_; }
  bool has_password() const { return password_; }
  bool has_query() const { return text_.find('?') != std::string::npos; }
  bool has_ref() const { return text_.find('#') != std::string::npos; }
  int IntPort() const { return port_; }
  const std::string& spec() const { return text_; }
  std::string_view host() const { return host_; }
  std::string_view path() const { return path_; }
  std::string Origin() const {
    return scheme_ + "://" + host_ + ":" + std::to_string(port_ == -1 && scheme_ == "https" ? 443 : port_);
  }
 private:
  std::string text_, scheme_, host_, path_;
  int port_ = -1;
  bool valid_ = false, username_ = false, password_ = false;
};
#endif
