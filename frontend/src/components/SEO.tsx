import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { config } from "../utils/config";

const publicTitle = `${config.companyName} — Personal & Business Loans`;
const publicDescription =
  "Apply for transparent personal and business loans online with flexible repayment terms and a simple digital application from Velo Finance LTD.";

function upsertMeta(attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertLink(rel: string, href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement("link");
    element.rel = rel;
    document.head.appendChild(element);
  }
  element.href = href;
}

export default function SEO() {
  const { pathname } = useLocation();

  useEffect(() => {
    const isPublicPage = pathname === "/";
    const origin = window.location.origin;
    const canonicalUrl = `${origin}${isPublicPage ? "/" : pathname}`;
    const title = isPublicPage ? publicTitle : `Secure application | ${config.companyName}`;
    const description = isPublicPage
      ? publicDescription
      : "This secure Velo Finance application area is for managing a loan request.";

    document.title = title;
    upsertMeta("name", "description", description);
    upsertMeta("name", "robots", isPublicPage ? "index, follow" : "noindex, nofollow");
    upsertMeta("name", "author", config.companyName);
    upsertMeta("property", "og:type", "website");
    upsertMeta("property", "og:title", title);
    upsertMeta("property", "og:description", description);
    upsertMeta("property", "og:url", canonicalUrl);
    upsertMeta("property", "og:site_name", config.companyName);
    upsertMeta("property", "og:image", config.brandLogoUrl || `${origin}/velo-logo.png`);
    upsertMeta("property", "og:image:alt", `${config.companyName} logo`);
    upsertMeta("name", "twitter:card", "summary_large_image");
    upsertMeta("name", "twitter:title", title);
    upsertMeta("name", "twitter:description", description);
    upsertMeta("name", "twitter:image", config.brandLogoUrl || `${origin}/velo-logo.png`);
    upsertLink("canonical", canonicalUrl);

    const existingSchema = document.getElementById("velo-seo-schema");
    if (existingSchema) existingSchema.remove();

    if (isPublicPage) {
      const schema = document.createElement("script");
      schema.id = "velo-seo-schema";
      schema.type = "application/ld+json";
      schema.textContent = JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            name: config.companyName,
            url: origin,
            logo: config.brandLogoUrl || `${origin}/velo-logo.png`,
          },
          {
            "@type": "FinancialService",
            name: config.companyName,
            url: origin,
            description: publicDescription,
            areaServed: { "@type": "Country", name: "Nigeria" },
            serviceType: ["Personal loans", "Business loans"],
          },
          {
            "@type": "WebSite",
            name: config.companyName,
            url: origin,
            description: publicDescription,
          },
        ],
      });
      document.head.appendChild(schema);
    }
  }, [pathname]);

  return null;
}
