package main

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadOneShotConfig(t *testing.T) {
	directory := t.TempDir()
	filePath := filepath.Join(directory, "proxy.json")
	if err := os.WriteFile(filePath, []byte(`{"version":1,"host":"proxy.test","port":1080,"username":"user","password":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := loadOneShotConfig(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if config.Host != "proxy.test" || config.Port != 1080 || config.Username != "user" || config.Password != "secret" {
		t.Fatalf("unexpected config: %#v", config)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("one-shot config still exists: %v", err)
	}
}

func TestLoadOneShotConfigRejectsBroadPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix permission bits")
	}
	filePath := filepath.Join(t.TempDir(), "proxy.json")
	if err := os.WriteFile(filePath, []byte(`{"version":1,"host":"proxy.test","port":1080}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOneShotConfig(filePath); err == nil {
		t.Fatal("expected broad permissions to be rejected")
	}
}

func TestGeneratedCertificateSPKI(t *testing.T) {
	certificate, spki, err := generateLocalCertificate(localProxyHost)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := parsed.VerifyHostname(localProxyHost); err != nil {
		t.Fatal(err)
	}
	publicKey, err := x509.MarshalPKIXPublicKey(parsed.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(publicKey)
	if expected := base64.StdEncoding.EncodeToString(digest[:]); spki != expected {
		t.Fatalf("SPKI mismatch: got %q, want %q", spki, expected)
	}
}
