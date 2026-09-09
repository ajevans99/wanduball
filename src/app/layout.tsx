import type { Metadata } from "next";
import { themeInitializationScript } from "@/lib/theme";
import "./globals.css";
import "./theme.css";

export const metadata: Metadata = {
  title: "Wanduball — Fantasy. Allegedly.",
  description: "Ten managers. Zero dignity. One wheel to ruin them all. The official headquarters of Wanduball fantasy football chaos.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitializationScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
