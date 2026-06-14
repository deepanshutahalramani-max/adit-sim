/**
 * LoginGate — Google Sign-In restricted to the allowed domain (@adit.com).
 *
 * Safe by design: if the backend has no GOOGLE_CLIENT_ID configured, the gate
 * is OFF and the app renders normally (a missing config can never lock anyone
 * out). When configured, users must sign in with their @adit.com Google account.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthConfig, authMe } from "../api";
import type { AuthUser } from "../api";
import { AuthContext } from "../context/AuthContext";

declare global {
  interface Window { google?: any; }
}

export function LoginGate({ children }: { children: React.ReactNode }) {
  const { data: cfg, isLoading } = useQuery({ queryKey: ["authConfig"], queryFn: fetchAuthConfig });
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const btnRef = useRef<HTMLDivElement>(null);

  const signOut = () => {
    localStorage.removeItem("adit_id_token");
    setUser(null);
    try { window.google?.accounts.id.disableAutoSelect(); } catch { /* noop */ }
  };

  // Validate an existing token on load
  useEffect(() => {
    if (!cfg?.enabled) { setChecked(true); return; }
    const t = localStorage.getItem("adit_id_token");
    if (!t) { setChecked(true); return; }
    authMe().then(setUser).catch(() => localStorage.removeItem("adit_id_token")).finally(() => setChecked(true));
  }, [cfg?.enabled]);

  // Render the Google button when needed
  useEffect(() => {
    if (!cfg?.enabled || user || !checked) return;
    const init = () => {
      if (!window.google || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: cfg.google_client_id,
        callback: async (resp: { credential: string }) => {
          localStorage.setItem("adit_id_token", resp.credential);
          try {
            setUser(await authMe());
            setError("");
          } catch (e) {
            localStorage.removeItem("adit_id_token");
            setError(e instanceof Error ? e.message : "Sign-in failed");
          }
        },
      });
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: "outline", size: "large", text: "signin_with", shape: "pill", width: 280,
      });
    };
    if (window.google) { init(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true; s.onload = init;
    document.head.appendChild(s);
  }, [cfg, user, checked]);

  if (isLoading || !checked) {
    return <div className="h-screen flex items-center justify-center text-ink-400 text-[13px]">Loading…</div>;
  }

  // Gate off → open access
  if (!cfg?.enabled) {
    return <AuthContext.Provider value={{ user: null, signOut }}>{children}</AuthContext.Provider>;
  }

  // Signed in
  if (user) {
    return <AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>;
  }

  // Login screen
  return (
    <div className="h-screen flex items-center justify-center bg-canvas">
      <div className="card shadow-pop w-[420px] p-8 text-center animate-scale-in">
        <div className="w-12 h-12 rounded-2xl bg-brand-500 shadow-brand mx-auto flex items-center justify-center text-white font-extrabold text-2xl mb-4">a</div>
        <h1 className="text-[20px] font-extrabold text-ink-900">Agent QA Platform</h1>
        <p className="text-[13px] text-ink-500 mt-1.5 mb-6">
          Sign in with your <span className="font-semibold text-ink-700">@{cfg.allowed_domain}</span> Google
          account to continue.
        </p>
        <div ref={btnRef} className="flex justify-center" />
        {error && <div className="text-[12.5px] text-[#B91C1C] mt-4 bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">{error}</div>}
        <p className="text-[11px] text-ink-300 mt-6">Access is restricted to {cfg.allowed_domain} team members.</p>
      </div>
    </div>
  );
}
