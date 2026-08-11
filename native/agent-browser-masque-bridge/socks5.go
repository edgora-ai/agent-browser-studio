package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

const (
	socksVersion          = 5
	socksCommandConnect   = 1
	socksCommandAssociate = 3
	socksAddressIPv4      = 1
	socksAddressDomain    = 3
	socksAddressIPv6      = 4
	socksHandshakeTimeout = 15 * time.Second
)

type endpoint struct {
	Host string
	Port int
}

type udpAssociation struct {
	control net.Conn
	socket  *net.UDPConn
	relay   *net.UDPAddr
}

func parseEndpoint(value string) (endpoint, error) {
	host, portValue, err := net.SplitHostPort(value)
	if err != nil {
		return endpoint{}, fmt.Errorf("parse target address: %w", err)
	}
	port, err := strconv.Atoi(portValue)
	if err != nil || port < 1 || port > 65535 {
		return endpoint{}, errors.New("target port is invalid")
	}
	host = strings.TrimSpace(strings.TrimSuffix(host, "."))
	if host == "" || strings.ContainsAny(host, "\x00\r\n") {
		return endpoint{}, errors.New("target host is invalid")
	}
	return endpoint{Host: host, Port: port}, nil
}

func dialSOCKSTCP(ctx context.Context, config socksConfig, target endpoint) (net.Conn, error) {
	connection, err := openSOCKSConnection(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := connection.SetDeadline(time.Now().Add(socksHandshakeTimeout)); err != nil {
		connection.Close()
		return nil, err
	}
	if _, err := sendSOCKSCommand(connection, socksCommandConnect, target); err != nil {
		connection.Close()
		return nil, err
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		connection.Close()
		return nil, err
	}
	return connection, nil
}

func openSOCKSUDPAssociation(ctx context.Context, config socksConfig) (*udpAssociation, error) {
	control, err := openSOCKSConnection(ctx, config)
	if err != nil {
		return nil, err
	}
	closeOnError := func(err error) (*udpAssociation, error) {
		control.Close()
		return nil, err
	}
	if err := control.SetDeadline(time.Now().Add(socksHandshakeTimeout)); err != nil {
		return closeOnError(err)
	}

	tcpLocal, ok := control.LocalAddr().(*net.TCPAddr)
	if !ok || tcpLocal.IP == nil {
		return closeOnError(errors.New("SOCKS connection has no local IP address"))
	}
	udpNetwork := "udp6"
	if tcpLocal.IP.To4() != nil {
		udpNetwork = "udp4"
	}
	socket, err := net.ListenUDP(udpNetwork, &net.UDPAddr{IP: tcpLocal.IP, Port: 0, Zone: tcpLocal.Zone})
	if err != nil {
		return closeOnError(fmt.Errorf("open SOCKS UDP socket: %w", err))
	}
	udpLocal := socket.LocalAddr().(*net.UDPAddr)
	bound, err := sendSOCKSCommand(control, socksCommandAssociate, endpoint{
		Host: udpLocal.IP.String(),
		Port: udpLocal.Port,
	})
	if err != nil {
		socket.Close()
		return closeOnError(err)
	}

	relayHost := bound.Host
	if relayIP := net.ParseIP(relayHost); relayIP != nil && relayIP.IsUnspecified() {
		remote, ok := control.RemoteAddr().(*net.TCPAddr)
		if !ok || remote.IP == nil {
			socket.Close()
			return closeOnError(errors.New("SOCKS UDP relay returned an unspecified address"))
		}
		relayHost = remote.IP.String()
	}
	relay, err := net.ResolveUDPAddr(udpNetwork, net.JoinHostPort(relayHost, strconv.Itoa(bound.Port)))
	if err != nil {
		socket.Close()
		return closeOnError(fmt.Errorf("resolve SOCKS UDP relay: %w", err))
	}
	if err := control.SetDeadline(time.Time{}); err != nil {
		socket.Close()
		return closeOnError(err)
	}
	return &udpAssociation{control: control, socket: socket, relay: relay}, nil
}

func openSOCKSConnection(ctx context.Context, config socksConfig) (net.Conn, error) {
	dialer := net.Dialer{Timeout: socksHandshakeTimeout, KeepAlive: 30 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(config.Host, strconv.Itoa(config.Port)))
	if err != nil {
		return nil, fmt.Errorf("connect to SOCKS proxy: %w", err)
	}
	if err := connection.SetDeadline(time.Now().Add(socksHandshakeTimeout)); err != nil {
		connection.Close()
		return nil, err
	}

	method := byte(0)
	if config.Username != "" {
		method = 2
	}
	if err := writeFull(connection, []byte{socksVersion, 1, method}); err != nil {
		connection.Close()
		return nil, fmt.Errorf("write SOCKS greeting: %w", err)
	}
	response := make([]byte, 2)
	if _, err := io.ReadFull(connection, response); err != nil {
		connection.Close()
		return nil, fmt.Errorf("read SOCKS greeting: %w", err)
	}
	if response[0] != socksVersion || response[1] != method {
		connection.Close()
		return nil, fmt.Errorf("SOCKS proxy rejected required authentication method: %d", response[1])
	}

	if method == 2 {
		username := []byte(config.Username)
		password := []byte(config.Password)
		request := make([]byte, 0, 3+len(username)+len(password))
		request = append(request, 1, byte(len(username)))
		request = append(request, username...)
		request = append(request, byte(len(password)))
		request = append(request, password...)
		if err := writeFull(connection, request); err != nil {
			connection.Close()
			return nil, fmt.Errorf("write SOCKS authentication: %w", err)
		}
		if _, err := io.ReadFull(connection, response); err != nil {
			connection.Close()
			return nil, fmt.Errorf("read SOCKS authentication: %w", err)
		}
		if response[0] != 1 || response[1] != 0 {
			connection.Close()
			return nil, errors.New("SOCKS authentication failed")
		}
	}
	return connection, nil
}

func sendSOCKSCommand(connection net.Conn, command byte, target endpoint) (endpoint, error) {
	address, err := encodeSOCKSAddress(target.Host)
	if err != nil {
		return endpoint{}, err
	}
	request := make([]byte, 0, 4+len(address)+2)
	request = append(request, socksVersion, command, 0)
	request = append(request, address...)
	request = binary.BigEndian.AppendUint16(request, uint16(target.Port))
	if err := writeFull(connection, request); err != nil {
		return endpoint{}, fmt.Errorf("write SOCKS command: %w", err)
	}

	header := make([]byte, 4)
	if _, err := io.ReadFull(connection, header); err != nil {
		return endpoint{}, fmt.Errorf("read SOCKS command response: %w", err)
	}
	if header[0] != socksVersion || header[2] != 0 {
		return endpoint{}, errors.New("SOCKS proxy returned an invalid command response")
	}
	if header[1] != 0 {
		return endpoint{}, fmt.Errorf("SOCKS proxy rejected command with reply code %d", header[1])
	}
	host, err := readSOCKSAddress(connection, header[3])
	if err != nil {
		return endpoint{}, err
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(connection, portBytes); err != nil {
		return endpoint{}, fmt.Errorf("read SOCKS bound port: %w", err)
	}
	return endpoint{Host: host, Port: int(binary.BigEndian.Uint16(portBytes))}, nil
}

func encodeSOCKSAddress(host string) ([]byte, error) {
	if ip := net.ParseIP(host); ip != nil {
		if ipv4 := ip.To4(); ipv4 != nil {
			return append([]byte{socksAddressIPv4}, ipv4...), nil
		}
		return append([]byte{socksAddressIPv6}, ip.To16()...), nil
	}
	encoded := []byte(host)
	if len(encoded) < 1 || len(encoded) > 255 || strings.ContainsAny(host, "\x00\r\n") {
		return nil, errors.New("SOCKS target hostname is invalid")
	}
	result := make([]byte, 0, 2+len(encoded))
	result = append(result, socksAddressDomain, byte(len(encoded)))
	return append(result, encoded...), nil
}

func readSOCKSAddress(reader io.Reader, addressType byte) (string, error) {
	var length int
	switch addressType {
	case socksAddressIPv4:
		length = net.IPv4len
	case socksAddressIPv6:
		length = net.IPv6len
	case socksAddressDomain:
		lengthByte := make([]byte, 1)
		if _, err := io.ReadFull(reader, lengthByte); err != nil {
			return "", fmt.Errorf("read SOCKS domain length: %w", err)
		}
		length = int(lengthByte[0])
		if length < 1 {
			return "", errors.New("SOCKS response contains an empty domain")
		}
	default:
		return "", fmt.Errorf("SOCKS response contains unsupported address type %d", addressType)
	}
	encoded := make([]byte, length)
	if _, err := io.ReadFull(reader, encoded); err != nil {
		return "", fmt.Errorf("read SOCKS address: %w", err)
	}
	if addressType == socksAddressDomain {
		return string(encoded), nil
	}
	return net.IP(encoded).String(), nil
}

func encodeSOCKSUDPFrame(target endpoint, payload []byte) ([]byte, error) {
	address, err := encodeSOCKSAddress(target.Host)
	if err != nil {
		return nil, err
	}
	frame := make([]byte, 0, 3+len(address)+2+len(payload))
	frame = append(frame, 0, 0, 0)
	frame = append(frame, address...)
	frame = binary.BigEndian.AppendUint16(frame, uint16(target.Port))
	return append(frame, payload...), nil
}

func parseSOCKSUDPFrame(frame []byte) (endpoint, []byte, error) {
	if len(frame) < 4 || frame[0] != 0 || frame[1] != 0 {
		return endpoint{}, nil, errors.New("invalid SOCKS UDP frame")
	}
	if frame[2] != 0 {
		return endpoint{}, nil, errors.New("fragmented SOCKS UDP frames are unsupported")
	}
	offset := 4
	var host string
	switch frame[3] {
	case socksAddressIPv4:
		if len(frame) < offset+net.IPv4len+2 {
			return endpoint{}, nil, errors.New("truncated SOCKS UDP IPv4 frame")
		}
		host = net.IP(frame[offset : offset+net.IPv4len]).String()
		offset += net.IPv4len
	case socksAddressIPv6:
		if len(frame) < offset+net.IPv6len+2 {
			return endpoint{}, nil, errors.New("truncated SOCKS UDP IPv6 frame")
		}
		host = net.IP(frame[offset : offset+net.IPv6len]).String()
		offset += net.IPv6len
	case socksAddressDomain:
		if len(frame) < offset+1 {
			return endpoint{}, nil, errors.New("truncated SOCKS UDP domain frame")
		}
		length := int(frame[offset])
		offset++
		if length < 1 || len(frame) < offset+length+2 {
			return endpoint{}, nil, errors.New("truncated SOCKS UDP domain frame")
		}
		host = string(frame[offset : offset+length])
		offset += length
	default:
		return endpoint{}, nil, errors.New("unsupported SOCKS UDP address type")
	}
	port := int(binary.BigEndian.Uint16(frame[offset : offset+2]))
	if port < 1 {
		return endpoint{}, nil, errors.New("invalid SOCKS UDP source port")
	}
	offset += 2
	return endpoint{Host: host, Port: port}, frame[offset:], nil
}

func sameUDPAddress(left, right *net.UDPAddr) bool {
	return left != nil && right != nil && left.Port == right.Port && left.IP.Equal(right.IP) && left.Zone == right.Zone
}

func writeFull(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		written, err := writer.Write(value)
		if err != nil {
			return err
		}
		if written < 1 {
			return io.ErrShortWrite
		}
		value = value[written:]
	}
	return nil
}

func (a *udpAssociation) Close() error {
	return errors.Join(a.socket.Close(), a.control.Close())
}
