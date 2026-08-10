package main

import (
	"bytes"
	"testing"
)

func TestSOCKSUDPFrameRoundTrip(t *testing.T) {
	tests := []endpoint{
		{Host: "192.0.2.10", Port: 443},
		{Host: "quic.example", Port: 8443},
		{Host: "2001:db8::10", Port: 53},
	}
	payload := []byte{0, 1, 2, 3, 255}
	for _, target := range tests {
		frame, err := encodeSOCKSUDPFrame(target, payload)
		if err != nil {
			t.Fatalf("encode %s: %v", target.Host, err)
		}
		decoded, decodedPayload, err := parseSOCKSUDPFrame(frame)
		if err != nil {
			t.Fatalf("decode %s: %v", target.Host, err)
		}
		if decoded.Host != target.Host || decoded.Port != target.Port || !bytes.Equal(decodedPayload, payload) {
			t.Fatalf("round trip mismatch: got %#v %x, want %#v %x", decoded, decodedPayload, target, payload)
		}
	}
}

func TestSOCKSUDPFrameRejectsFragments(t *testing.T) {
	frame, err := encodeSOCKSUDPFrame(endpoint{Host: "192.0.2.10", Port: 443}, []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	frame[2] = 1
	if _, _, err := parseSOCKSUDPFrame(frame); err == nil {
		t.Fatal("expected fragmented frame rejection")
	}
}

func TestAcceptableResponseTarget(t *testing.T) {
	if !acceptableResponseTarget(
		endpoint{Host: "quic.example", Port: 443},
		endpoint{Host: "198.51.100.7", Port: 443},
	) {
		t.Fatal("domain targets should accept a resolved response address")
	}
	if acceptableResponseTarget(
		endpoint{Host: "192.0.2.1", Port: 443},
		endpoint{Host: "192.0.2.2", Port: 443},
	) {
		t.Fatal("literal IP targets must reject a different response address")
	}
}
