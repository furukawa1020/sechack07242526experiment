import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface SecurityOptions {
  readonly allowLan: boolean;
  readonly bindHost: string;
  readonly operatorToken?: string;
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(":", 1)[0] ?? host;
}

function isAllowedHost(hostHeader: string | undefined, options: SecurityOptions): boolean {
  if (hostHeader === undefined) return false;
  const hostname = stripPort(hostHeader.toLowerCase());
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return options.allowLan;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.get("origin");
  if (origin === undefined) return true;

  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === request.get("host")?.toLowerCase();
  } catch {
    return false;
  }
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

/**
 * Strict, dependency-free security headers for this local-only application.
 * No wildcard CORS response is ever emitted.
 */
export function securityMiddleware(options: SecurityOptions) {
  return (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'none'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
      ].join("; "),
    );
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-DNS-Prefetch-Control", "off");
    response.setHeader("X-Frame-Options", "DENY");
    if (request.path.startsWith("/api/") || request.path === "/healthz") {
      response.setHeader("Cache-Control", "no-store");
    }

    if (!isAllowedHost(request.get("host"), options)) {
      response.status(403).json({ error: "許可されていないHostです。", code: "HOST_NOT_ALLOWED" });
      return;
    }

    if (!isSameOrigin(request)) {
      response.status(403).json({ error: "異なるオリジンからの要求は許可されていません。", code: "ORIGIN_NOT_ALLOWED" });
      return;
    }

    const participantApi = request.path.startsWith("/api/display/");
    if (
      options.allowLan &&
      request.path.startsWith("/api/") &&
      !participantApi &&
      (options.operatorToken === undefined ||
        !tokenMatches(request.get("x-operator-token"), options.operatorToken))
    ) {
      response.status(401).json({ error: "Operator tokenが必要です。", code: "OPERATOR_TOKEN_REQUIRED" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.setHeader("Allow", "GET,HEAD,POST,DELETE,OPTIONS");
      response.status(204).end();
      return;
    }

    next();
  };
}
