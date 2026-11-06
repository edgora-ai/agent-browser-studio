// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#include "content/shell/android/agent_browser_product/chromium/agent_browser_android_product_policy.h"

#include <initializer_list>

#include "base/command_line.h"
#include "base/test/gtest_util.h"
#include "base/test/scoped_command_line.h"
#include "net/base/net_errors.h"
#include "net/base/proxy_chain.h"
#include "net/base/proxy_server.h"
#include "net/log/net_log_with_source.h"
#include "net/proxy_resolution/proxy_config.h"
#include "net/proxy_resolution/proxy_config_with_annotation.h"
#include "net/proxy_resolution/proxy_info.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace content {
namespace {

base::CommandLine ProxyCommand(const char* endpoint) {
  base::CommandLine command(base::CommandLine::NO_PROGRAM);
  command.AppendSwitch(kAgentBrowserProductProfileSwitch);
  command.AppendSwitchASCII("proxy-server", endpoint);
  command.AppendSwitchASCII("proxy-bypass-list", "<-loopback>");
  // These unrelated product switches must remain accepted.
  command.AppendSwitch("disable-quic");
  command.AppendSwitchASCII("force-webrtc-ip-handling-policy",
                            "disable_non_proxied_udp");
  return command;
}

TEST(AgentBrowserProductProxyTest, OneEndpointForAllSchemesIncludingLoopback) {
  const struct {
    const char* endpoint;
    net::ProxyServer::Scheme scheme;
    const char* host;
    int port;
  } cases[] = {
      {"http://192.168.4.100:7890", net::ProxyServer::SCHEME_HTTP,
       "192.168.4.100", 7890},
      {"https://proxy.example:443", net::ProxyServer::SCHEME_HTTPS,
       "proxy.example", 443},
      {"socks5://proxy.example:1080", net::ProxyServer::SCHEME_SOCKS5,
       "proxy.example", 1080},
      {"http://[2001:db8::1]:8080", net::ProxyServer::SCHEME_HTTP,
       "[2001:db8::1]", 8080},
      {"HTTPS://proxy.example:8443", net::ProxyServer::SCHEME_HTTPS,
       "proxy.example", 8443},
  };
  for (const auto& test : cases) {
    SCOPED_TRACE(test.endpoint);
    net::ProxyConfig config;
    ASSERT_TRUE(ParseAgentBrowserProductProxyConfig(ProxyCommand(test.endpoint),
                                                   &config));
    EXPECT_FALSE(config.HasAutomaticSettings());
    EXPECT_FALSE(config.from_system());
    EXPECT_FALSE(config.has_pac_url());
    const auto& rules = config.proxy_rules();
    ASSERT_EQ(net::ProxyConfig::ProxyRules::Type::PROXY_LIST, rules.type);
    ASSERT_EQ(1u, rules.single_proxies.size());
    EXPECT_TRUE(rules.proxies_for_http.IsEmpty());
    EXPECT_TRUE(rules.proxies_for_https.IsEmpty());
    EXPECT_TRUE(rules.proxies_for_ftp.IsEmpty());
    EXPECT_TRUE(rules.fallback_proxies.IsEmpty());
    EXPECT_FALSE(rules.reverse_bypass);
    ASSERT_EQ(1u, rules.bypass_rules.rules().size());
    const auto& chain = rules.single_proxies.First();
    ASSERT_TRUE(chain.IsValid());
    ASSERT_TRUE(chain.is_single_proxy());
    EXPECT_FALSE(chain.is_direct());
    EXPECT_EQ(test.scheme, chain.First().scheme());
    EXPECT_EQ(test.host, chain.First().GetHost());
    EXPECT_EQ(test.port, chain.First().GetPort());
    for (const char* url : {
             "http://example.test/", "https://example.test/",
             "ws://example.test/socket", "wss://example.test/socket",
             "ftp://example.test/file", "http://localhost/",
             "https://localhost/", "ws://localhost/socket",
             "wss://localhost/socket", "http://sub.localhost/",
             "http://127.0.0.1/", "https://127.0.0.1/", "http://[::1]/",
             "http://169.254.1.2/", "http://intranet/"}) {
      SCOPED_TRACE(url);
      const GURL target(url);
      ASSERT_TRUE(target.is_valid());
      net::ProxyInfo result;
      rules.Apply(target, &result);
      EXPECT_FALSE(result.is_direct());
      EXPECT_FALSE(result.did_bypass_proxy());
      ASSERT_EQ(1u, result.proxy_list().size());
      EXPECT_EQ(chain, result.proxy_chain());
      // Exhausting the sole proxy must not introduce a DIRECT alternative.
      EXPECT_FALSE(result.Fallback(net::ERR_PROXY_CONNECTION_FAILED,
                                   net::NetLogWithSource()));
      EXPECT_TRUE(result.is_empty());
      EXPECT_FALSE(result.is_direct());
    }
  }
}

TEST(AgentBrowserProductProxyTest, RejectsMalformedAndAlternativeEndpoints) {
  for (const char* endpoint : {
           "", "DIRECT", "direct://", "system", "proxy.example:7890",
           "http://", "http://proxy.example", "http://proxy.example:",
           "http://proxy.example:0", "http://proxy.example:65536",
           "http://proxy.example:-1", "http://proxy.example:+80",
           "http://proxy.example:bad", "http://:80", "http://[::1:80",
           "http://::1:80", "http://[not-ip]:80", "socks://proxy.example:1080",
           "socks4://proxy.example:1080", "quic://proxy.example:443",
           "ftp://proxy.example:21", "pac://proxy.example:80",
           "http://user:pass@proxy.example:80", "http://@proxy.example:80",
           "http://proxy.example:80/", "http://proxy.example:80/path",
           "http://proxy.example:80?query", "http://proxy.example:80#fragment",
           "http://proxy.example:80\\path", "http://pro%78y.example:80",
           "http://proxy.example:80,https://other.example:443",
           "http://proxy.example:80;DIRECT", "http://proxy.example:80;",
           "http=proxy.example:80;https=proxy.example:80",
           "http=http://proxy.example:80",
           "[https://proxy.example:443 https://other.example:443]",
           "http://proxy.example :80", " http://proxy.example:80",
           "http://proxy.example:80 ", "http://proxy.example:80\n"}) {
    SCOPED_TRACE(endpoint);
    net::ProxyConfig config = net::ProxyConfig::CreateAutoDetect();
    const net::ProxyConfig original(config);
    EXPECT_FALSE(ParseAgentBrowserProductProxyConfig(ProxyCommand(endpoint),
                                                    &config));
    EXPECT_TRUE(config.Equals(original));
  }
}

TEST(AgentBrowserProductProxyTest, RequiresEndpointAndExactBypass) {
  auto command = ProxyCommand("http://proxy.example:80");
  command.RemoveSwitch("proxy-server");
  EXPECT_FALSE(ParseAgentBrowserProductProxyConfig(command));
  command = ProxyCommand("http://proxy.example:80");
  command.RemoveSwitch("proxy-bypass-list");
  EXPECT_FALSE(ParseAgentBrowserProductProxyConfig(command));
  for (const char* bypass : {"", "*", "<local>", "localhost", "127.0.0.1",
                            "<-loopback>;localhost", " <-loopback>",
                            "<-loopback>;", "<-loopback>,"}) {
    SCOPED_TRACE(bypass);
    command = ProxyCommand("http://proxy.example:80");
    command.AppendSwitchASCII("proxy-bypass-list", bypass);
    EXPECT_FALSE(ParseAgentBrowserProductProxyConfig(command));
  }
  command = ProxyCommand("http://proxy.example:80");
  command.RemoveSwitch(kAgentBrowserProductProfileSwitch);
  EXPECT_TRUE(ParseAgentBrowserProductProxyConfig(command));
}

TEST(AgentBrowserProductProxyTest, RejectsCompetingProxySwitches) {
  for (const char* name : {"proxy-pac-url", "proxy-auto-detect", "no-proxy-server",
                          "use-system-proxy-resolver", "winhttp-proxy-resolver",
                          "proxy-resolver-v8-tracing", "proxy-unknown"}) {
    SCOPED_TRACE(name);
    auto command = ProxyCommand("http://proxy.example:80");
    command.AppendSwitchASCII(name, "http://pac.example/proxy.pac");
    EXPECT_FALSE(ParseAgentBrowserProductProxyConfig(command));
  }
}

TEST(AgentBrowserProductProxyTest, OrdinaryShellAndPreflightStayUnchanged) {
  base::test::ScopedCommandLine scoped_command;
  auto* command = scoped_command.GetProcessCommandLine();
  *command = ProxyCommand("DIRECT");
  command->RemoveSwitch(kAgentBrowserProductProfileSwitch);
  auto params = network::mojom::NetworkContextParams::New();
  ConfigureAgentBrowserProductNetworkContextParams(params.get());
  EXPECT_FALSE(params->initial_proxy_config.has_value());
  // Preflight alone is not the product-profile marker.
  command->AppendSwitch(kAgentBrowserProductPreflightSwitch);
  ConfigureAgentBrowserProductNetworkContextParams(params.get());
  EXPECT_FALSE(params->initial_proxy_config.has_value());
  params->initial_proxy_config = net::ProxyConfigWithAnnotation::CreateDirect();
  ConfigureAgentBrowserProductNetworkContextParams(params.get());
  ASSERT_TRUE(params->initial_proxy_config.has_value());
  EXPECT_TRUE(params->initial_proxy_config->value().proxy_rules().empty());
}

TEST(AgentBrowserProductProxyTest, InstallsFixedInitialConfiguration) {
  base::test::ScopedCommandLine scoped_command;
  auto* command = scoped_command.GetProcessCommandLine();
  *command = ProxyCommand("http://192.168.4.100:7890");
  auto params = network::mojom::NetworkContextParams::New();
  ConfigureAgentBrowserProductNetworkContextParams(params.get());
  ASSERT_TRUE(params->initial_proxy_config.has_value());
  EXPECT_FALSE(params->proxy_config_client_receiver.is_valid());
  EXPECT_FALSE(params->proxy_config_poller_client.is_valid());
  EXPECT_FALSE(params->initial_custom_proxy_config);
  EXPECT_FALSE(params->custom_proxy_config_client_receiver.is_valid());
  net::ProxyConfig expected;
  ASSERT_TRUE(ParseAgentBrowserProductProxyConfig(*command, &expected));
  EXPECT_TRUE(params->initial_proxy_config->value().Equals(expected));
  EXPECT_NE(net::ProxyConfigWithAnnotation::CreateDirect()
                .traffic_annotation()
                .unique_id_hash_code,
            params->initial_proxy_config->traffic_annotation()
                .unique_id_hash_code);
}

TEST(AgentBrowserProductProxyDeathTest, InvalidProductProxyCannotBecomeDirect) {
  base::test::ScopedCommandLine scoped_command;
  *scoped_command.GetProcessCommandLine() = ProxyCommand("DIRECT");
  auto params = network::mojom::NetworkContextParams::New();
  EXPECT_CHECK_DEATH(
      ConfigureAgentBrowserProductNetworkContextParams(params.get()));
}

TEST(AgentBrowserProductProxyDeathTest, RequiresMandatoryProductProxySwitches) {
  base::test::ScopedCommandLine scoped_command;
  auto* command = scoped_command.GetProcessCommandLine();
  for (const char* missing : {"proxy-server", "proxy-bypass-list"}) {
    SCOPED_TRACE(missing);
    *command = ProxyCommand("http://proxy.example:80");
    command->RemoveSwitch(missing);
    auto params = network::mojom::NetworkContextParams::New();
    EXPECT_CHECK_DEATH(
        ConfigureAgentBrowserProductNetworkContextParams(params.get()));
  }
  *command = base::CommandLine(base::CommandLine::NO_PROGRAM);
  command->AppendSwitch(kAgentBrowserProductProfileSwitch);
  auto params = network::mojom::NetworkContextParams::New();
  EXPECT_CHECK_DEATH(
      ConfigureAgentBrowserProductNetworkContextParams(params.get()));
}

TEST(AgentBrowserProductProxyDeathTest, RejectsExistingAlternativeConfiguration) {
  base::test::ScopedCommandLine scoped_command;
  *scoped_command.GetProcessCommandLine() = ProxyCommand("http://proxy.example:80");
  auto params = network::mojom::NetworkContextParams::New();
  params->initial_proxy_config = net::ProxyConfigWithAnnotation::CreateDirect();
  EXPECT_CHECK_DEATH(
      ConfigureAgentBrowserProductNetworkContextParams(params.get()));
}

}  // namespace
}  // namespace content
