package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

const (
	localProxyHost = "agent-browser-masque.local"
	localListenIP  = "127.0.0.1"
)

type readyMessage struct {
	Version      int      `json:"version"`
	ProxyHost    string   `json:"proxyHost"`
	ListenHost   string   `json:"listenHost"`
	Port         int      `json:"port"`
	SPKI         string   `json:"spki"`
	Capabilities []string `json:"capabilities"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "agent-browser-masque-bridge: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var configPath string
	var watchStdin bool
	flag.StringVar(&configPath, "config", "", "mode-0600 one-shot SOCKS configuration file")
	flag.BoolVar(&watchStdin, "watch-stdin", false, "stop when the parent closes stdin")
	flag.Parse()
	if flag.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}

	config, err := loadOneShotConfig(configPath)
	if err != nil {
		return err
	}
	packetConnection, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(localListenIP), Port: 0})
	if err != nil {
		return fmt.Errorf("listen for local QUIC proxy: %w", err)
	}
	defer packetConnection.Close()
	port := packetConnection.LocalAddr().(*net.UDPAddr).Port

	certificate, spki, err := generateLocalCertificate(localProxyHost)
	if err != nil {
		return err
	}
	template, err := proxyTemplate(localProxyHost, port)
	if err != nil {
		return fmt.Errorf("construct MASQUE URI template: %w", err)
	}
	logLevel := slog.LevelWarn
	if os.Getenv("AGENT_BROWSER_MASQUE_BRIDGE_DEBUG") == "1" || os.Getenv("ROXY_MASQUE_BRIDGE_DEBUG") == "1" {
		logLevel = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel}))
	handler := &bridgeHandler{config: config, template: template, logger: logger}
	server := &http3.Server{
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{certificate},
			MinVersion:   tls.VersionTLS13,
		},
		QUICConfig: &quic.Config{
			EnableDatagrams: true,
			MaxIdleTimeout:  2 * time.Minute,
			KeepAlivePeriod: 30 * time.Second,
		},
		Handler:         handler,
		EnableDatagrams: true,
		IdleTimeout:     2 * time.Minute,
		Logger:          logger,
	}

	baseContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	shutdown, stop := signal.NotifyContext(baseContext, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if watchStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			cancel()
		}()
	}

	message := readyMessage{
		Version:      1,
		ProxyHost:    localProxyHost,
		ListenHost:   localListenIP,
		Port:         port,
		SPKI:         spki,
		Capabilities: []string{"connect", "connect-udp", "socks5-auth"},
	}
	if err := json.NewEncoder(os.Stdout).Encode(message); err != nil {
		return fmt.Errorf("write readiness message: %w", err)
	}

	go func() {
		<-shutdown.Done()
		_ = server.Close()
		_ = packetConnection.Close()
	}()

	err = server.Serve(packetConnection)
	if shutdown.Err() != nil || errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
