package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"

	"github.com/quic-go/masque-go"
	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/quic-go/quicvarint"
	"github.com/yosida95/uritemplate/v3"
)

const (
	maxMASQUEPayload    = 1500
	maxSOCKSUDPFrame    = 64 * 1024
	datagramCapsuleType = http3.CapsuleType(0)
)

var contextIDZero = quicvarint.Append([]byte{}, 0)

type bridgeHandler struct {
	config   socksConfig
	template *uritemplate.Template
	logger   *slog.Logger
}

func (h *bridgeHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodConnect {
		writer.Header().Set("Allow", http.MethodConnect)
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if request.Proto == "connect-udp" {
		h.handleUDP(writer, request)
		return
	}
	h.handleTCP(writer, request)
}

func (h *bridgeHandler) handleTCP(writer http.ResponseWriter, request *http.Request) {
	target, err := parseEndpoint(request.Host)
	if err != nil {
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	upstream, err := dialSOCKSTCP(request.Context(), h.config, target)
	if err != nil {
		h.logger.Warn("SOCKS CONNECT failed", "error", err)
		writer.WriteHeader(http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	writer.WriteHeader(http.StatusOK)
	streamer, ok := writer.(http3.HTTPStreamer)
	if !ok {
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	stream := streamer.HTTPStream()
	defer stream.Close()

	errorsChannel := make(chan error, 2)
	go func() {
		_, copyErr := io.Copy(upstream, stream)
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		errorsChannel <- copyErr
	}()
	go func() {
		_, copyErr := io.Copy(stream, upstream)
		_ = stream.Close()
		errorsChannel <- copyErr
	}()

	firstError := <-errorsChannel
	_ = upstream.Close()
	stream.CancelRead(quic.StreamErrorCode(http3.ErrCodeNoError))
	_ = stream.Close()
	secondError := <-errorsChannel
	if err := firstNonClosedError(firstError, secondError); err != nil {
		h.logger.Debug("QUIC CONNECT tunnel closed", "error", err)
	}
}

func (h *bridgeHandler) handleUDP(writer http.ResponseWriter, request *http.Request) {
	proxyRequest, err := masque.ParseProxyRequest(request, h.template)
	if err != nil {
		var parseError *masque.ProxyRequestParseError
		if errors.As(err, &parseError) {
			writer.WriteHeader(parseError.HTTPStatus)
		} else {
			writer.WriteHeader(http.StatusBadRequest)
		}
		return
	}
	target, err := parseEndpoint(proxyRequest.Target)
	if err != nil {
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	association, err := openSOCKSUDPAssociation(request.Context(), h.config)
	if err != nil {
		h.logger.Warn("SOCKS UDP ASSOCIATE failed", "error", err)
		writer.WriteHeader(http.StatusBadGateway)
		return
	}
	defer association.Close()
	h.logger.Debug("CONNECT-UDP relay established", "relay", association.relay.String(), "target_port", target.Port)

	streamer, ok := writer.(http3.HTTPStreamer)
	if !ok {
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	writer.Header().Set(http3.CapsuleProtocolHeader, "?1")
	writer.WriteHeader(http.StatusOK)
	stream := streamer.HTTPStream()
	defer stream.Close()

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	errorsChannel := make(chan error, 4)
	go func() { errorsChannel <- relayMASQUEToSOCKS(ctx, stream, association, target, h.logger) }()
	go func() { errorsChannel <- relaySOCKSToMASQUE(ctx, stream, association, target, h.logger) }()
	go func() {
		errorsChannel <- consumeCapsules(request.Context(), stream, association, target, h.logger)
	}()
	go func() {
		buffer := make([]byte, 1)
		_, controlErr := association.control.Read(buffer)
		errorsChannel <- controlErr
	}()

	firstError := <-errorsChannel
	cancel()
	_ = association.Close()
	stream.CancelRead(quic.StreamErrorCode(http3.ErrCodeNoError))
	_ = stream.Close()
	remaining := []error{firstError}
	for index := 0; index < 3; index++ {
		remaining = append(remaining, <-errorsChannel)
	}
	if err := firstNonClosedError(remaining...); err != nil {
		h.logger.Debug("CONNECT-UDP flow closed", "error", err)
	}
}

func relayMASQUEToSOCKS(
	ctx context.Context,
	stream *http3.Stream,
	association *udpAssociation,
	target endpoint,
	logger *slog.Logger,
) error {
	packets := 0
	for {
		datagram, err := stream.ReceiveDatagram(ctx)
		if err != nil {
			return err
		}
		contextID, offset, err := quicvarint.Parse(datagram)
		if err != nil || contextID != 0 {
			continue
		}
		payload := datagram[offset:]
		if len(payload) > maxMASQUEPayload {
			continue
		}
		frameBytes, err := relayPayloadToSOCKS(association, target, payload)
		if err != nil {
			return err
		}
		packets++
		if packets <= 3 {
			logger.Debug("relayed MASQUE datagram to SOCKS", "payload_bytes", len(payload), "frame_bytes", frameBytes)
		}
	}
}

func relayPayloadToSOCKS(association *udpAssociation, target endpoint, payload []byte) (int, error) {
	frame, err := encodeSOCKSUDPFrame(target, payload)
	if err != nil {
		return 0, err
	}
	written, err := association.socket.WriteToUDP(frame, association.relay)
	if err != nil {
		return 0, err
	}
	if written != len(frame) {
		return 0, io.ErrShortWrite
	}
	return len(frame), nil
}

func relaySOCKSToMASQUE(
	ctx context.Context,
	stream *http3.Stream,
	association *udpAssociation,
	target endpoint,
	logger *slog.Logger,
) error {
	buffer := make([]byte, maxSOCKSUDPFrame)
	packets := 0
	for {
		length, source, err := association.socket.ReadFromUDP(buffer)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !sameUDPAddress(source, association.relay) {
			logger.Debug("ignored UDP packet from unexpected relay", "source", source.String())
			continue
		}
		responseTarget, payload, err := parseSOCKSUDPFrame(buffer[:length])
		if err != nil {
			logger.Debug("ignored invalid SOCKS UDP frame", "error", err, "frame_bytes", length)
			continue
		}
		if !acceptableResponseTarget(target, responseTarget) || len(payload) > maxMASQUEPayload {
			logger.Debug("ignored SOCKS UDP response target", "response_port", responseTarget.Port, "payload_bytes", len(payload))
			continue
		}
		datagram := make([]byte, 0, len(contextIDZero)+len(payload))
		datagram = append(datagram, contextIDZero...)
		datagram = append(datagram, payload...)
		usedCapsule, err := sendMASQUEPayload(stream, datagram)
		if err != nil {
			return err
		}
		packets++
		if packets <= 3 {
			logger.Debug("relayed SOCKS datagram to MASQUE", "payload_bytes", len(payload), "capsule", usedCapsule)
		}
	}
}

type masqueDatagramWriter interface {
	io.Writer
	SendDatagram([]byte) error
}

func sendMASQUEPayload(stream masqueDatagramWriter, datagram []byte) (bool, error) {
	if err := stream.SendDatagram(datagram); err != nil {
		var tooLarge *quic.DatagramTooLargeError
		if !errors.As(err, &tooLarge) {
			return false, err
		}
		if err := http3.WriteCapsule(
			quicvarint.NewWriter(stream), datagramCapsuleType, datagram,
		); err != nil {
			return true, err
		}
		return true, nil
	}
	return false, nil
}

func consumeCapsules(
	ctx context.Context,
	stream *http3.Stream,
	association *udpAssociation,
	target endpoint,
	logger *slog.Logger,
) error {
	reader := quicvarint.NewReader(stream)
	for {
		capsuleType, capsule, err := http3.ParseCapsule(reader)
		if err != nil {
			return err
		}
		if capsuleType != datagramCapsuleType {
			if _, err := io.Copy(io.Discard, capsule); err != nil {
				return err
			}
			continue
		}
		value, err := io.ReadAll(io.LimitReader(capsule, maxMASQUEPayload+2))
		if err != nil {
			return err
		}
		if len(value) > maxMASQUEPayload+1 {
			if _, err := io.Copy(io.Discard, capsule); err != nil {
				return err
			}
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		contextID, offset, err := quicvarint.Parse(value)
		if err != nil || contextID != 0 {
			continue
		}
		payload := value[offset:]
		if _, err := relayPayloadToSOCKS(association, target, payload); err != nil {
			return err
		}
		logger.Debug("relayed MASQUE capsule to SOCKS", "payload_bytes", len(payload))
	}
}

func acceptableResponseTarget(requested, response endpoint) bool {
	if requested.Port != response.Port {
		return false
	}
	requestedIP := net.ParseIP(requested.Host)
	if requestedIP == nil {
		return true
	}
	responseIP := net.ParseIP(response.Host)
	return responseIP != nil && requestedIP.Equal(responseIP)
}

func firstNonClosedError(values ...error) error {
	for _, value := range values {
		if value == nil || errors.Is(value, io.EOF) || errors.Is(value, net.ErrClosed) ||
			errors.Is(value, context.Canceled) || errors.Is(value, http.ErrServerClosed) {
			continue
		}
		return value
	}
	return nil
}

func proxyTemplate(proxyHost string, port int) (*uritemplate.Template, error) {
	return uritemplate.New(fmt.Sprintf(
		"https://%s/.well-known/masque/udp/{target_host}/{target_port}/",
		net.JoinHostPort(proxyHost, fmt.Sprintf("%d", port)),
	))
}
