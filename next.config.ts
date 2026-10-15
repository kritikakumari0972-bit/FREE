import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/**/*": ["./bin/**/*"],
  },
  // Ensure Next.js doesn't bundle Node.js built-ins in unexpected ways
  serverExternalPackages: [],
};

export default nextConfig;
