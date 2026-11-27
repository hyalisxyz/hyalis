import { useSession } from "../lib/session";
import { short } from "../lib/format";

/** Connect / connected control. `variant="bar"` matches the light floating header. */
export function WalletButton({ variant = "app" }: { variant?: "bar" | "app" }) {
  const s = useSession();
  if (!s.connected) {
    return variant === "bar" ? (
      <button className="btn-connect" onClick={s.connect} disabled={s.connecting}>
        {s.connecting ? "Connecting" : "Connect"}
      </button>
    ) : (
      <button className="btn btn-primary btn-sm" onClick={s.connect} disabled={s.connecting}>
        {s.connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  return variant === "bar" ? (
    <button className="btn-connect" onClick={s.disconnect} title="Disconnect">
      {short(s.address, 5, 4)}
    </button>
  ) : (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {!s.token ? (
        <button className="btn btn-ghost btn-sm" onClick={s.signIn} disabled={s.signingIn}>
          {s.signingIn ? "Check your wallet…" : "Sign in"}
        </button>
      ) : null}
      <button className="btn btn-ghost btn-sm mono" onClick={s.disconnect} title="Disconnect">
        {short(s.address, 6, 4)}
      </button>
    </div>
  );
}

export function SessionError() {
  const s = useSession();
  return s.error ? <div className="notice err" style={{ margin: "12px 0" }}>{s.error}</div> : null;
}
