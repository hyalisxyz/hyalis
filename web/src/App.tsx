import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

// Each page loads its own code when it is opened, so the landing page does not carry the
// dashboard and the dashboard does not carry the 3D scene.
const Landing = lazy(() => import("./pages/Landing"));
const Docs = lazy(() => import("./pages/Docs"));
const Terms = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Privacy })));
const Risk = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Risk })));
const AppShell = lazy(() => import("./components/AppShell"));
const Overview = lazy(() => import("./pages/app/Overview"));
const AgentDetail = lazy(() => import("./pages/app/AgentDetail"));
const NewAgent = lazy(() => import("./pages/app/NewAgent"));
const Proofs = lazy(() => import("./pages/app/Proofs"));
const WalletPage = lazy(() => import("./pages/app/WalletPage"));
const Trade = lazy(() => import("./pages/app/Trade"));
const RunPage = lazy(() => import("./pages/app/RunPage"));
const MyAgents = lazy(() => import("./pages/app/Lists").then((m) => ({ default: m.MyAgents })));
const Markets = lazy(() => import("./pages/app/Lists").then((m) => ({ default: m.Markets })));

function NotFound() {
  return (
    <main className="page" style={{ margin: "80px auto", textAlign: "center" }}>
      <h1 style={{ fontFamily: "var(--display)" }}>Nothing here</h1>
      <p className="dim">This page does not exist.</p>
      <Link className="btn btn-primary" to="/">Go home</Link>
    </main>
  );
}

/** Shown for the moment a page's code is loading: the background only, so nothing jumps. */
function Loading() {
  return <div className="page-loading" aria-busy="true" />;
}

/** Every route; the browser wraps it in a BrowserRouter, the build-time prerender in a StaticRouter. */
export function AppRoutes() {
  return (
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/risk" element={<Risk />} />
          <Route path="/app" element={<AppShell />}>
            <Route index element={<Overview />} />
            <Route path="new" element={<NewAgent />} />
            <Route path="mine" element={<MyAgents />} />
            <Route path="agents/:id" element={<AgentDetail />} />
            <Route path="markets" element={<Markets />} />
            <Route path="trade" element={<Trade />} />
            <Route path="run" element={<RunPage />} />
            <Route path="proofs" element={<Proofs />} />
            <Route path="wallet" element={<WalletPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
