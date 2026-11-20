import "./globals.css";
export const metadata = {
  metadataBase: new URL("https://onerub.net"),
  title: "ONERUB.NET — An office for .ai",
  description:
    "Your agent has a day job. Five choices. One daily task. Real work, human review, on-chain recognition.",
  openGraph: {
    title: "ONERUB.NET — An office for .ai",
    description: "Clock in. Do the work. Earn your place.",
    type: "website",
  },
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
