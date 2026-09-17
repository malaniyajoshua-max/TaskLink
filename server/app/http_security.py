"""Bounded ingress for the local REST service, including chunked request bodies.

No proxy headers are trusted here. A public deployment must use an HTTPS reverse
proxy, explicit allowed hosts, and a shared gateway rate limiter for multiple workers.
"""

import asyncio
from collections import OrderedDict, deque
import json
import os
import time
import uuid
from urllib.parse import urlsplit

MAX_BODY = 8 * 1024 * 1024
MAX_RATE_KEYS = 4096
rate_windows: OrderedDict[str, deque] = OrderedDict()


class SecurityMiddleware:
    def __init__(self, app):
        self.app = app
        self.hosts = {
            s.strip().lower()
            for s in os.getenv(
                "TASKLINK_ALLOWED_HOSTS", "localhost,127.0.0.1,::1"
            ).split(",")
            if s.strip()
        }
        if not self.hosts or "*" in self.hosts:
            raise RuntimeError(
                "TASKLINK_ALLOWED_HOSTS must contain explicit host names"
            )
        self.auth_inflight = 0
        self.media_inflight = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        headers = scope.get("headers", [])
        response_headers = [
            (b"x-request-id", request_id.encode()),
            (b"cache-control", b"no-store"),
            (b"x-content-type-options", b"nosniff"),
            (b"referrer-policy", b"no-referrer"),
            (b"x-frame-options", b"DENY"),
        ]

        async def secure_send(message):
            if message["type"] == "http.response.start":
                names = {key for key, _ in response_headers}
                message = {
                    **message,
                    "headers": [
                        (k, v)
                        for k, v in message.get("headers", [])
                        if k.lower() not in names
                    ]
                    + response_headers,
                }
            await send(message)

        async def reject(status, code, message):
            body = json.dumps(
                dict(code=code, message=message, request_id=request_id)
            ).encode()
            extra = [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ]
            if status == 429:
                extra.append((b"retry-after", b"60"))
            await secure_send(
                {"type": "http.response.start", "status": status, "headers": extra}
            )
            await secure_send({"type": "http.response.body", "body": body})

        hosts = [v.decode("latin-1") for k, v in headers if k.lower() == b"host"]
        try:
            parsed = urlsplit("//" + hosts[0]) if len(hosts) == 1 else None
            host = parsed.hostname if parsed else None
            if parsed and (
                parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
                or any(c.isspace() for c in hosts[0])
            ):
                host = None
            if parsed:
                _ = parsed.port  # Validate numeric port and range too.
        except ValueError:
            host = None
        if host not in self.hosts:
            return await reject(400, "invalid_host", "请求主机未获授权")
        # Desktop network requests originate in the worker and do not have Origin.
        # Reject browser-based cross-site access, even on loopback (DNS rebinding).
        if any(k.lower() == b"origin" for k, _ in headers):
            return await reject(
                403, "origin_denied", "此接口只接受受信任的桌面客户端请求"
            )
        lengths = [v for k, v in headers if k.lower() == b"content-length"]
        try:
            length = int(lengths[0]) if lengths else 0
            if len(lengths) > 1 or length < 0:
                raise ValueError()
        except ValueError:
            return await reject(400, "invalid_length", "请求长度无效")
        if length > MAX_BODY:
            return await reject(413, "body_too_large", "请求不能超过 8 MB")
        auth = scope["path"].startswith("/api/v1/auth/") and scope["method"] == "POST"
        media = scope["path"].startswith(
            ("/api/v1/attachments", "/api/v1/profile/avatar")
        )
        if media and self.media_inflight >= 4:
            return await reject(429, "transfer_busy", "附件服务繁忙，请稍后重试")
        if auth:
            current = time.monotonic()
            while rate_windows:
                first = next(iter(rate_windows))
                if rate_windows[first] and rate_windows[first][-1] >= current - 60:
                    break
                rate_windows.pop(first)
            key = (scope.get("client") or ("unknown", 0))[0]
            if key not in rate_windows:
                if len(rate_windows) >= MAX_RATE_KEYS:
                    return await reject(429, "rate_limited", "请求过于频繁，请稍后重试")
                rate_windows[key] = deque()
            window = rate_windows[key]
            rate_windows.move_to_end(key)
            while window and window[0] < current - 60:
                window.popleft()
            if len(window) >= 60 or self.auth_inflight >= 4:
                return await reject(429, "rate_limited", "请求过于频繁，请稍后重试")
            window.append(current)
        body = bytearray()
        try:
            async with asyncio.timeout(15):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body.extend(message.get("body", b""))
                    if len(body) > MAX_BODY:
                        return await reject(413, "body_too_large", "请求不能超过 8 MB")
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            return await reject(408, "request_timeout", "请求接收超时")
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        if auth and self.auth_inflight >= 4:
            return await reject(429, "rate_limited", "请求过于频繁，请稍后重试")
        if media and self.media_inflight >= 4:
            return await reject(429, "transfer_busy", "附件服务繁忙，请稍后重试")
        if auth:
            self.auth_inflight += 1
        if media:
            self.media_inflight += 1
        try:
            return await self.app(scope, bounded_receive, secure_send)
        finally:
            if media:
                self.media_inflight -= 1
            if auth:
                self.auth_inflight -= 1
