import { StrictMode } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { StaticRouter } from "react-router-dom";
import { SessionProvider } from "./lib/session";
import { AppRoutes } from "./App";

/**
 * Renders a page to HTML at build time (web/scripts/prerender.mjs), so the landing page paints
 * before any JavaScript runs. It is the same tree the browser renders (main.tsx), so the browser
 * takes the HTML over (hydrates) instead of drawing it again. Live figures fill in afterwards.
 */
export async function render(url: string): Promise<string> {
  const { prelude } = await prerenderToNodeStream(
    <StrictMode>
      <SessionProvider>
        <StaticRouter location={url}>
          <AppRoutes />
        </StaticRouter>
      </SessionProvider>
    </StrictMode>,
  );
  const chunks: Buffer[] = [];
  for await (const c of prelude) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
