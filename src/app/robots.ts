import type { MetadataRoute } from "next";
import { SITE_URL } from "./_landing/constants";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // The authenticated app itself isn't useful to index — a crawler can't sign in, and
        // every one of these routes redirects an anonymous visitor away anyway.
        disallow: ["/cases", "/clients", "/blueprints", "/members", "/settings", "/portal", "/onboarding"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
