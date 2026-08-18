import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/register"];
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/cron/"];

// Exact paths, deliberately not prefixes. The container HEALTHCHECK has no
// session cookie, so /api/health must be reachable without one — but matching
// by prefix would also expose anything else beginning with that name.
const PUBLIC_API_ROUTES = ["/api/health"];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Matched on the SHAPE of an asset path, not merely its suffix.
//
// Everything in public/ is served either from the root (/site.webmanifest,
// /favicon-32x32.png) or from public/fonts/. Nothing static lives deeper. A
// bare "ends in a known extension" test therefore lets route paths through,
// because Next.js dynamic segments match dotted text: /b/1/securities/2.json
// is a page and /api/b/1/transactions/5.json is a handler. Pages carry no auth
// of their own, so for them this gate is the only authentication there is.
//
// The leading anchor is what closes that class, and it also makes a separate
// /api/ exclusion unnecessary — no /api/ path has the single-segment shape
// below. The test "serves every file that actually exists in public/" fails if
// a new asset directory is added without updating this pattern.
const STATIC_ASSET_RE =
  /^\/(?:fonts\/)?[^/]+\.(?:css|js|mjs|map|json|txt|xml|webmanifest|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot)$/i;

function isCrossOriginWrite(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  if (!request.nextUrl.pathname.startsWith("/api/")) return false;

  // "same-site" (e.g. a sibling subdomain) is rejected identically to
  // "cross-site" — deliberately: nothing legitimate posts to this app from a
  // sibling subdomain, and treating same-site as trusted would widen the hole
  // this check exists to close.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin";

  const origin = request.headers.get("origin");
  if (!origin) return false;

  // Prefer the Host header: behind a reverse proxy (Tailscale Serve, Caddy)
  // nextUrl reports the internal address rather than the one the browser used.
  // Fall back to nextUrl when Host is absent, which is the case for a
  // programmatically constructed NextRequest — without the fallback, every
  // same-origin request in the test suite would compare against null and 403.
  //
  // Requirement on self-hosters: the reverse proxy in front of this app must
  // preserve the original Host header. Tailscale Serve does this by default.
  // nginx does NOT — its default `proxy_set_header Host $proxy_host` replaces
  // it with the upstream address, which would make every write 403 with an
  // opaque "Cross-origin request rejected". See the README's "Security notes
  // for self-hosting" section.
  const host = request.headers.get("host") ?? request.nextUrl.host;

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Before the public-route returns below: /api/auth/ is public, and login is
  // exactly where cross-site request forgery would be aimed.
  if (isCrossOriginWrite(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }

  // Allow static assets and Next.js internals. See STATIC_ASSET_RE above for
  // why this matches an asset's path shape rather than just its extension.
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    STATIC_ASSET_RE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Allow public routes
  if (PUBLIC_ROUTES.includes(pathname)) {
    return NextResponse.next();
  }

  // Allow public API routes
  if (
    PUBLIC_API_ROUTES.includes(pathname) ||
    PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }

  // Check for session cookie (lightweight check — full validation in API helpers)
  const sessionCookie = request.cookies.get("counterpoise_session");
  if (!sessionCookie?.value) {
    // API routes get 401, pages get redirected
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all routes except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
