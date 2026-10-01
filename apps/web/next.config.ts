import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: [
    "@hot-potato/db",
    "@hot-potato/email-composer",
    "@hot-potato/integrations",
    "@hot-potato/router",
  ],
  async headers() {
    const publicHeaders = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
    ];
    return [
      { source: "/r/:path*", headers: publicHeaders },
      { source: "/schedule/:path*", headers: publicHeaders },
      { source: "/email/outlook", headers: publicHeaders },
      { source: "/email/outlook/:path*", headers: publicHeaders },
      { source: "/api/email-tools/:path*", headers: publicHeaders },
      {
        source: "/api/integrations/google-workspace-addon",
        headers: publicHeaders,
      },
      { source: "/api/scheduling/:path*", headers: publicHeaders },
      { source: "/api/router-links/:path*", headers: publicHeaders },
      {
        source: "/schedule/manage/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
          },
        ],
      },
      {
        source: "/embed/v1.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, immutable",
          },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/email/outlook/assets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, immutable",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
};

export default config;
