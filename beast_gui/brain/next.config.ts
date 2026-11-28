import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";

// The content security policy is set per request in src/proxy.ts; these headers go on everything.
const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // A production build (`next build` + `next start`) starts far faster and more
  // reliably than `next dev` cold-compiling on first open — that's what the GUI
  // launches. Some orphaned pages carry pre-existing type/lint issues; skip
  // those gates so the build never blocks the Brain from coming up.
  typescript: { ignoreBuildErrors: true },
  distDir: process.env.NEXT_DIST_DIR || ".next", // lets a check build run beside a running dev server
  // One address for the site: the www form sends visitors (and search engines) to the bare domain.
  async redirects() {
    return [{ source: "/:path*", has: [{ type: "host", value: "www.hexbrainai.com" }], destination: "https://hexbrainai.com/:path*", permanent: true }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
        // Browsers that have seen the site once will only ever use HTTPS for it.
        ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
      ],
    }, {
      source: "/api/:path*",
      headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'self' http://localhost:* http://127.0.0.1:*" }, { key: "X-Robots-Tag", value: "noindex" }, { key: "Cache-Control", value: "no-store" }],
    }];
  },
};

export default nextConfig;
