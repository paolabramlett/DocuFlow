import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // The marketing landing page (src/app/_landing) hotlinks Unsplash stock photography rather
    // than shipping downloaded binary assets into the repo — Unsplash's license permits this, and
    // it avoids reproducing files sourced from an untrusted origin. No other remote host is used
    // anywhere else in the app.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
};

export default nextConfig;
