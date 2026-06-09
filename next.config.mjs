/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Permissions-Policy",
            value: "local-network-access=(self)",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
