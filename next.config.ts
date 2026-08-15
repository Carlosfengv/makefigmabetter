import type { NextConfig } from "next";

const development = process.env.NODE_ENV !== "production";
const documentApiTarget = process.env.MAKEFIGMA_DOCUMENT_API_TARGET ?? "http://127.0.0.1:8788";
const assetApiTarget = process.env.MAKEFIGMA_ASSET_API_TARGET ?? "http://127.0.0.1:8789";
const workspaceApiTarget = process.env.MAKEFIGMA_WORKSPACE_API_TARGET ?? "http://127.0.0.1:8790";
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next emits inline bootstrapping/style tags. WASM evaluation is explicitly allowed
  // for the local Rust bridge; arbitrary network scripts are never allowed.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Browser traffic stays same-origin; deployment supplies authenticated proxy
  // targets instead of granting the page direct API origins in CSP.
  `connect-src 'self'${development ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Allows an evidence run to use its own build output while a developer's
  // interactive `next dev` instance keeps the default `.next` lock.
  distDir: process.env.MAKEFIGMA_NEXT_DIST_DIR ?? ".next",
  outputFileTracingRoot: process.cwd(),
  // The local editor and its evidence browser both use the loopback host.
  // Declare it explicitly so Next development HMR is not rejected as a
  // cross-origin request on newer Next versions.
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.31.93"],
  async rewrites() {
    // The desktop in-app browser can enforce stricter private-network rules
    // than a normal Chrome tab. Keep Asset API calls same-origin and proxy them
    // through Next so imports never depend on cross-port browser fetch support.
    return [
      { source: "/document-api/:path*", destination: `${documentApiTarget}/:path*` },
      { source: "/asset-api/:path*", destination: `${assetApiTarget}/:path*` },
      { source: "/workspace-api/:path*", destination: `${workspaceApiTarget}/:path*` },
    ];
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default nextConfig;
