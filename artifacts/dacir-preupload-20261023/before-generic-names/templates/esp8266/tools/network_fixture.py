#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Offline TCP echo / MQTT 3.1.1 QoS0 test server; not a production broker.

Real TCP sockets, no MCU/model access. Bind loopback by default. Optional local
HTTP control publishes downlink through MQTT, which still traverses ESP UART.
"""
import argparse
import json
from pathlib import Path
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def encode(header, body=b''):
    remaining = len(body)
    prefix = bytearray([header])
    while True:
        byte = remaining % 128
        remaining //= 128
        prefix.append(byte | (128 if remaining else 0))
        if not remaining:
            return bytes(prefix) + body


def mqtt_text(value):
    value = value.encode() if isinstance(value, str) else value
    return len(value).to_bytes(2, 'big') + value


def exact(connection, length):
    result = bytearray()
    while len(result) < length:
        part = connection.recv(length - len(result))
        if not part:
            raise EOFError()
        result.extend(part)
    return bytes(result)


def read_packet(connection):
    header = exact(connection, 1)[0]
    remaining, multiplier = 0, 1
    for _ in range(4):
        byte = exact(connection, 1)[0]
        remaining += (byte & 127) * multiplier
        if not byte & 128:
            if remaining > 4096:
                raise ValueError('fixture packet limit')
            return header, exact(connection, remaining)
        multiplier *= 128
    raise ValueError('malformed remaining length')


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class NetworkFixture:
    def __init__(self, mode='mqtt', host='127.0.0.1', port=0, log=None):
        if mode not in ('mqtt', 'echo'):
            raise ValueError('mode')
        self.mode, self.records, self.clients, self.lock = mode, [], set(), threading.RLock()
        self.log_path = Path(log) if log else None
        fixture = self

        class Handler(socketserver.BaseRequestHandler):
            def setup(self):
                self.topics, self.send_lock, self.joined = set(), threading.Lock(), False
                self.request.settimeout(300)
                with fixture.lock:
                    fixture.clients.add(self)
                fixture.record('connect', peer=self.client_address[0])

            def send(self, data):
                with self.send_lock:
                    self.request.sendall(data)

            def handle(self):
                try:
                    if fixture.mode == 'echo':
                        while True:
                            data = self.request.recv(4096)
                            if not data:
                                break
                            fixture.record('echo_rx', hex=data.hex())
                            self.send(data)
                    else:
                        while True:
                            header, body = read_packet(self.request)
                            kind = header >> 4
                            fixture.record('packet', header=header, hex=body.hex())
                            if header == 0x10:
                                if self.joined or len(body) < 12 or body[:8] != b'\x00\x04MQTT\x04\x02':
                                    raise ValueError('only MQTT 3.1.1 clean-session without authentication')
                                n = int.from_bytes(body[10:12], 'big')
                                if len(body) != 12 + n or not n:
                                    raise ValueError('client id')
                                self.joined = True
                                self.send(b'\x20\x02\x00\x00')
                                fixture.record('mqtt_connected', client_id=body[12:].decode('utf-8'))
                            elif not self.joined:
                                raise ValueError('CONNECT required')
                            elif header == 0x82:
                                if len(body) < 6:
                                    raise ValueError('SUBSCRIBE')
                                n = int.from_bytes(body[2:4], 'big')
                                if len(body) != n + 5 or not n or not int.from_bytes(body[:2], 'big') or body[-1] != 0:
                                    raise ValueError('one exact QoS0 subscription required')
                                topic = body[4:4+n].decode('utf-8')
                                if '+' in topic or '#' in topic:
                                    raise ValueError('wildcards unsupported')
                                self.topics.add(topic)
                                self.send(encode(0x90, body[:2] + b'\x00'))
                                fixture.record('subscribe', topic=topic)
                            elif kind == 3 and header & 0xfe == 0x30:
                                if len(body) < 3:
                                    raise ValueError('PUBLISH')
                                n = int.from_bytes(body[:2], 'big')
                                if not n or n + 2 > len(body):
                                    raise ValueError('topic length')
                                topic = body[2:2+n].decode('utf-8')
                                fixture.record('publish_received', topic=topic, hex=body[2+n:].hex(), text=body[2+n:].decode('utf-8', 'replace'))
                                fixture.publish(topic, body[2+n:])
                            elif header == 0xc0 and not body:
                                self.send(b'\xd0\x00')
                            elif header == 0xe0 and not body:
                                break
                            else:
                                raise ValueError('unsupported packet')
                except (EOFError, ConnectionError, OSError):
                    pass
                except (ValueError, UnicodeError) as error:
                    fixture.record('protocol_error', message=str(error))

            def finish(self):
                with fixture.lock:
                    fixture.clients.discard(self)
                fixture.record('disconnect')

        self.server = _Server((host, port), Handler)
        self.host, self.port = self.server.server_address
        self.thread = None

    def record(self, event, **fields):
        record = dict(event=event, monotonic=time.monotonic(), **fields)
        with self.lock:
            self.records.append(record)
            if self.log_path:
                with self.log_path.open('a') as stream:
                    stream.write(json.dumps(record, ensure_ascii=False) + '\n')

    def publish(self, topic, payload):
        if isinstance(payload, str):
            payload = payload.encode()
        data = encode(0x30, mqtt_text(topic) + payload)
        delivered = 0
        with self.lock:
            recipients = list(self.clients)
        for client in recipients:
            if client.joined and topic in client.topics:
                try:
                    client.send(data)
                    delivered += 1
                except OSError:
                    pass
        self.record('publish_forwarded', topic=topic, hex=payload.hex(), subscribers=delivered)
        return delivered

    def start(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def close(self):
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            client.request.close()
        if self.thread:
            self.server.shutdown()
            self.thread.join(timeout=2)
        self.server.server_close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *args):
        self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('mqtt', 'echo'), default='mqtt')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18883)
    parser.add_argument('--http-port', type=int, default=0, help='Optional local control endpoint')
    parser.add_argument('--log', type=Path)
    args = parser.parse_args()
    with NetworkFixture(args.mode, args.host, args.port, args.log) as fixture:
        print(json.dumps(dict(mode=args.mode, host=fixture.host, port=fixture.port)), flush=True)
        if args.http_port:
            class Control(BaseHTTPRequestHandler):
                def do_GET(self):
                    with fixture.lock:
                        content = json.dumps(fixture.records[-100:], ensure_ascii=False).encode()
                    self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(content)

                def do_POST(self):
                    try:
                        size = int(self.headers.get('Content-Length', '0'))
                        if size <= 0 or size > 2048:
                            raise ValueError('request size')
                        message = json.loads(self.rfile.read(size))
                        topic, payload = message['topic'], message['payload']
                        if not isinstance(topic, str) or not topic or len(topic) > 128 or not isinstance(payload, str):
                            raise ValueError('topic/payload')
                        delivered = fixture.publish(topic, payload)
                        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(dict(delivered=delivered)).encode())
                    except (ValueError, KeyError, TypeError):
                        self.send_response(400); self.end_headers()

            control = ThreadingHTTPServer((args.host, args.http_port), Control)
            try:
                control.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                control.server_close()
        else:
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
