package main

import (
	"bytes"
	"errors"
	"testing"

	"github.com/quic-go/quic-go"
)

type recordingMasqueWriter struct {
	sendError error
	datagrams [][]byte
	body      bytes.Buffer
}

func (w *recordingMasqueWriter) SendDatagram(value []byte) error {
	w.datagrams = append(w.datagrams, bytes.Clone(value))
	return w.sendError
}

func (w *recordingMasqueWriter) Write(value []byte) (int, error) {
	return w.body.Write(value)
}

func TestSendMASQUEPayloadUsesDatagramWhenItFits(t *testing.T) {
	writer := &recordingMasqueWriter{}
	payload := []byte{0, 1, 2, 3}
	usedCapsule, err := sendMASQUEPayload(writer, payload)
	if err != nil {
		t.Fatal(err)
	}
	if usedCapsule {
		t.Fatal("unexpected capsule fallback")
	}
	if len(writer.datagrams) != 1 || !bytes.Equal(writer.datagrams[0], payload) {
		t.Fatalf("unexpected datagram: %x", writer.datagrams)
	}
	if writer.body.Len() != 0 {
		t.Fatalf("unexpected capsule bytes: %x", writer.body.Bytes())
	}
}

func TestSendMASQUEPayloadFallsBackToDatagramCapsule(t *testing.T) {
	writer := &recordingMasqueWriter{
		sendError: &quic.DatagramTooLargeError{MaxDatagramPayloadSize: 3},
	}
	payload := []byte{0, 1, 2, 3}
	usedCapsule, err := sendMASQUEPayload(writer, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !usedCapsule {
		t.Fatal("expected capsule fallback")
	}
	want := []byte{0, byte(len(payload)), 0, 1, 2, 3}
	if !bytes.Equal(writer.body.Bytes(), want) {
		t.Fatalf("capsule = %x, want %x", writer.body.Bytes(), want)
	}
}

func TestSendMASQUEPayloadReturnsOtherDatagramErrors(t *testing.T) {
	want := errors.New("send failed")
	writer := &recordingMasqueWriter{sendError: want}
	usedCapsule, err := sendMASQUEPayload(writer, []byte{0, 1})
	if usedCapsule || !errors.Is(err, want) {
		t.Fatalf("usedCapsule=%v error=%v, want false and %v", usedCapsule, err, want)
	}
	if writer.body.Len() != 0 {
		t.Fatalf("unexpected capsule bytes: %x", writer.body.Bytes())
	}
}
