import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { SessionProvider } from "./lib/session";
import App from "./App";
import "./fonts.css";
import "./styles.css";

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
