import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { SessionProvider } from "./lib/session";
import App from "./App";
import { reloadForNewVersion } from "./lib/reload";
import "./fonts.css";
import "./styles.css";

// A chunk from an older build failed to load (the site was updated while this tab was open).
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForNewVersion()) e.preventDefault();
});

const tree = (
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>
);
// The landing page arrives prerendered (scripts/prerender.mjs): take its HTML over instead of drawing it again.
const root = document.getElementById("root")!;
if (root.firstElementChild) hydrateRoot(root, tree);
else createRoot(root).render(tree);
