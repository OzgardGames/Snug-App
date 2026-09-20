import type { Metadata } from "next";
import { Poppins, Sora, Nunito, Baloo_2 } from "next/font/google";
import Script from "next/script";
import { ThemeProvider } from "@/lib/theme";
import { DesktopTitleBar } from "@/components/DesktopTitleBar";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  weight: ["600", "700", "800"],
  subsets: ["latin"],
});

const sora = Sora({
  variable: "--font-sora",
  weight: ["600", "700", "800"],
  subsets: ["latin"],
});

const nunito = Nunito({
  variable: "--font-nunito",
  weight: ["400", "600", "700", "800"],
  subsets: ["latin"],
});

const baloo2 = Baloo_2({
  variable: "--font-baloo",
  weight: ["700", "800"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Snug",
  description: "No channels, no setup — just a code and you're in.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${poppins.variable} ${sora.variable} ${nunito.variable} ${baloo2.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col overflow-hidden font-body bg-snug-bg text-snug-text">
        <Script src="/theme-init.js" strategy="beforeInteractive" />
        <ThemeProvider>
          <DesktopTitleBar />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
