import {readFileSync} from 'node:fs';
const nextConfig = {
  async generateBuildId() {
    return JSON.parse(readFileSync(new URL('./artifacts/release/manifest.json', import.meta.url), 'utf8')).buildId;
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
