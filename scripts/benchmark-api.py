#!/usr/bin/env python3
"""Measure HTTP latency and process RSS against an already seeded benchmark server.

Use a dedicated database and a container started from the production image. The
server must be PID 1 so /proc/1/status reports its RSS.
"""

import argparse
import base64
import json
import math
import os
import socket
import subprocess
import time
from http.cookies import SimpleCookie
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def process_kib(container, field="VmRSS"):
    status = subprocess.check_output(
        ["docker", "exec", container, "cat", "/proc/1/status"], text=True
    )
    for line in status.splitlines():
        if line.startswith(f"{field}:"):
            return int(line.split()[1])
    raise RuntimeError(f"{field} missing from container PID 1 status")


def get(opener, url):
    start = time.perf_counter_ns()
    with opener.open(Request(url, headers={"Cache-Control": "no-cache"}), timeout=30) as response:
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"{url}: HTTP {response.status}: {body[:200]!r}")
        json.loads(body)
    return (time.perf_counter_ns() - start) / 1_000_000


def open_socket(url, cookie):
    """Opens the book socket over plain HTTP and reads its `ready` message."""
    start = time.perf_counter_ns()
    parts = urlsplit(url)
    if parts.scheme != "http":
        raise RuntimeError(f"{url}: the benchmark opens sockets over plain HTTP only")
    connection = socket.create_connection((parts.hostname, parts.port or 80), timeout=30)
    reader = connection.makefile("rb")
    try:
        key = base64.b64encode(os.urandom(16)).decode()
        connection.sendall((
            f"GET {parts.path} HTTP/1.1\r\nHost: {parts.netloc}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"Cookie: {cookie}\r\n\r\n"
        ).encode())
        status = reader.readline()
        if b" 101 " not in status:
            raise RuntimeError(f"{url}: unexpected socket response: {status!r}")
        while reader.readline() not in (b"\r\n", b""):
            pass
        # The server's frames are not masked. `ready` is one short text frame.
        first, second = reader.read(2)
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(reader.read(2), "big")
        elif length == 127:
            length = int.from_bytes(reader.read(8), "big")
        message = json.loads(reader.read(length))
        if first & 0x0F != 1 or message.get("type") != "ready":
            raise RuntimeError(f"{url}: the first message is not ready: {message!r}")
    except Exception:
        reader.close()
        connection.close()
        raise
    return (time.perf_counter_ns() - start) / 1_000_000, (reader, connection)


def close_socket(stream):
    reader, connection = stream
    reader.close()
    connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3100")
    parser.add_argument("--container", required=True)
    parser.add_argument("--book-id", type=int, default=1)
    parser.add_argument("--account-id", type=int, required=True)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--socket-connections", type=int, default=10)
    parser.add_argument("--idle-seconds", type=int, default=30)
    args = parser.parse_args()
    if min(args.samples, args.socket_connections) < 1 or min(args.warmup, args.idle_seconds) < 0:
        parser.error("samples and socket-connections must be positive; warmup and idle-seconds cannot be negative")

    opener = build_opener()
    credentials = json.dumps({
        "username": os.environ.get("BENCH_USER", "admin"),
        "password": os.environ.get("BENCH_PASSWORD", "password"),
    }).encode()
    with opener.open(Request(
        f"{args.base_url}/api/auth/login", data=credentials,
        headers={"Content-Type": "application/json"}, method="POST"
    ), timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"login: HTTP {response.status}")
        cookies = SimpleCookie()
        for header in response.headers.get_all("Set-Cookie", []):
            cookies.load(header)
        if "counterpoise_session" not in cookies:
            raise RuntimeError("login did not set a session cookie")
        # Production sets Secure even on localhost HTTP. Python's cookie jar
        # rejects that cookie, unlike browsers' localhost exception.
        cookie = f"counterpoise_session={cookies['counterpoise_session'].value}"
        opener.addheaders = [("Cookie", cookie)]
        response.read()

    base = f"{args.base_url}/api/b/{args.book_id}"
    routes = {
        "account_list": f"{base}/accounts",
        "register_page": f"{base}/transactions?{urlencode({'accountId': args.account_id, 'limit': 100, 'offset': 0})}",
        "income_statement": f"{base}/reports/income-statement",
        "positions": f"{base}/investments/positions",
        "search": f"{base}/search?{urlencode({'q': 'Checking'})}",
    }
    result = {"config": vars(args), "routes": {}, "rss_kib": {"before": process_kib(args.container)}}
    for name, url in routes.items():
        for _ in range(args.warmup):
            get(opener, url)
        values = [get(opener, url) for _ in range(args.samples)]
        result["routes"][name] = {
            "p50_ms": round(percentile(values, 0.5), 2),
            "p95_ms": round(percentile(values, 0.95), 2),
            "rss_kib": process_kib(args.container),
        }

    socket_url = f"{base}/socket"
    for _ in range(args.warmup):
        _, stream = open_socket(socket_url, cookie)
        close_socket(stream)
    values = []
    for _ in range(args.samples):
        elapsed, stream = open_socket(socket_url, cookie)
        values.append(elapsed)
        close_socket(stream)
    result["routes"]["socket_ready"] = {
        "p50_ms": round(percentile(values, 0.5), 2),
        "p95_ms": round(percentile(values, 0.95), 2),
        "rss_kib": process_kib(args.container),
    }
    streams = []
    try:
        for _ in range(args.socket_connections):
            _, stream = open_socket(socket_url, cookie)
            streams.append(stream)
        time.sleep(args.idle_seconds)
        result["rss_kib"]["socket_idle"] = process_kib(args.container)
    finally:
        for stream in streams:
            close_socket(stream)
    result["rss_kib"]["after"] = process_kib(args.container)
    result["rss_kib"]["peak"] = process_kib(args.container, "VmHWM")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
