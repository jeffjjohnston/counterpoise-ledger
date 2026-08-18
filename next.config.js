const { default: { version } } = await import("./package.json", {
  with: { type: "json" },
});

const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    // No script-src or style-src: those are the directives that break Next.js
    // hydration and PostHog. A nonce-based policy is deliberately deferred.
    value:
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Don't advertise the framework in an X-Powered-By response header.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  // Read at call time, not module load, so the flag is testable without
  // resetting the module registry.
  async headers() {
    const headers = [...SECURITY_HEADERS];
    if (process.env.ENABLE_HSTS === "true") {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      });
    }
    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
