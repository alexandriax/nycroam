import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';

const GA_MEASUREMENT_ID = 'G-R6F21T632T';

// Absolute base for og:image and friends. This page is statically prerendered,
// so these are read at BUILD time — on Vercel the production alias is set then;
// locally it falls back to the dev origin.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  'http://localhost:3000';

const title = 'NYC Roam: Open-world Manhattan with realistic transit';
const description =
  'Roam an open-world 3D Manhattan in your browser. Every street and building from OpenStreetMap, ' +
  'real terrain and trees, and subway entrances you can walk down into, then board a train and ride the line.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: 'NYC Roam',
  keywords: [
    'Manhattan', 'New York City', '3D city', 'OpenStreetMap', 'Three.js',
    'WebGL', 'subway', 'MTA', 'first person', 'browser',
  ],
  openGraph: {
    type: 'website',
    siteName: 'NYC Roam',
    title,
    description,
    url: siteUrl,
    locale: 'en_US',
  },
  // no twitter-image file: Twitter/X falls back to the opengraph-image
  twitter: { card: 'summary_large_image', title, description },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b0e12',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Questrial is on the critical path twice over: the HUD, and every sign
            texture we bake (World.init blocks on it). @font-face alone wouldn't
            request it until first paint. latin-ext stays lazy — accented street
            names are rare enough not to spend a preload on. */}
        <link
          rel="preload"
          href="/fonts/questrial-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        {/* Archivo Black is also on the critical path: every bold sign texture
            baked in World.init blocks on it (see fonts.ts loadSans). */}
        <link
          rel="preload"
          href="/fonts/archivo-black-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} strategy="afterInteractive" />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_MEASUREMENT_ID}');
          `}
        </Script>
        {children}
      </body>
    </html>
  );
}
