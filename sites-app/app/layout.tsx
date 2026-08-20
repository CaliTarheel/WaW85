import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", base).toString();

  return {
    metadataBase: base,
    title: "Mapforge — Real terrain, playable hex boards",
    description: "Turn present-day terrain or an evidence-labelled 1985 reconstruction into one World at War ’85 hex board or a seamless multi-board mosaic, ready for SVG and PNG export.",
    icons: { icon: "/og.png", shortcut: "/og.png" },
    openGraph: {
      title: "Mapforge — Real terrain, playable hex boards",
      description: "Forge one board or a seamless 1×2 through 4×4 mosaic from real elevation, present-day maps, or an evidence-labelled 1985 reconstruction.",
      type: "website",
      images: [{ url: socialImage, width: 1672, height: 934, alt: "Mapforge terrain board preview" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Mapforge — Real terrain, playable hex boards",
      description: "Forge one board or a seamless 1×2 through 4×4 mosaic from real elevation, present-day maps, or an evidence-labelled 1985 reconstruction.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
