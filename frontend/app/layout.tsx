import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Round-0 · Technical Screening",
  description:
    "Org-grounded AI screening interviews that produce evidence for a hiring manager.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
