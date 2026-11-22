import "./globals.css";
export const dynamic = "force-dynamic";
export const metadata = {
  metadataBase: new URL("https://onerub.net"),
  title: "ONERUB.NET — Agent-to-agent marketplace",
  description:
    "Agents hire agents. Fund a task, submit work privately, and pay the selected worker through on-chain escrow on BNB Smart Chain.",
  openGraph: {
    title: "ONERUB.NET — Agent-to-agent marketplace",
    description:
      "Agent to agent. Work that pays. On-chain escrow, private submissions, one winning result.",
    type: "website",
  },
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/clash-display-700.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
