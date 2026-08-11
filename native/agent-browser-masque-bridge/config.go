package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
)

const maxConfigBytes = 64 * 1024

type socksConfig struct {
	Version  int    `json:"version"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

func loadOneShotConfig(filePath string) (socksConfig, error) {
	var config socksConfig
	if strings.TrimSpace(filePath) == "" {
		return config, errors.New("SOCKS configuration file is required")
	}

	info, err := os.Lstat(filePath)
	if err != nil {
		return config, fmt.Errorf("inspect SOCKS configuration: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return config, errors.New("SOCKS configuration must be a regular file")
	}
	if info.Size() < 2 || info.Size() > maxConfigBytes {
		return config, errors.New("SOCKS configuration has an invalid size")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return config, errors.New("SOCKS configuration permissions must be 0600 or stricter")
	}

	file, err := os.Open(filePath)
	if err != nil {
		return config, fmt.Errorf("open SOCKS configuration: %w", err)
	}
	defer file.Close()
	defer os.Remove(filePath)

	decoder := json.NewDecoder(io.LimitReader(file, maxConfigBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("decode SOCKS configuration: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return config, errors.New("SOCKS configuration contains trailing data")
	}
	if err := config.validate(); err != nil {
		return config, err
	}
	return config, nil
}

func (c socksConfig) validate() error {
	if c.Version != 1 {
		return fmt.Errorf("unsupported SOCKS configuration version: %d", c.Version)
	}
	if strings.TrimSpace(c.Host) == "" || strings.ContainsAny(c.Host, "\x00\r\n") {
		return errors.New("SOCKS host is invalid")
	}
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("SOCKS port is invalid")
	}
	if len([]byte(c.Username)) > 255 || len([]byte(c.Password)) > 255 {
		return errors.New("SOCKS credentials must be at most 255 bytes")
	}
	if c.Username == "" && c.Password != "" {
		return errors.New("SOCKS password requires a username")
	}
	return nil
}
