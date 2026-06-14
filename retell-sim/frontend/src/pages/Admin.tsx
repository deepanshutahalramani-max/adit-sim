/**
 * Admin — usage + audit (admin emails only). Shows who's using the platform,
 * how many simulations each has run, and a full per-user action audit log.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, ScrollText } from "lucide-react";
import { fetchAdminUsage, fetchAdminAudit } from "../api";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card card-pad !p-4">
      <div className="section-label">{label}</div>
      <div className="text-[26px] font-extrabold text-ink-900 mt-1">{value}</div>
    </div>
  );
}

function fmtAgo(s: number): string {
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Admin() {
  const [tab, setTab] = useState<"usage" | "audit">("usage");
  const { data: usage } = useQuery({ queryKey: ["adminUsage"], queryFn: fetchAdminUsage, refetchInterval: 8000 });
  const { data: audit } = useQuery({ queryKey: ["adminAudit"], queryFn: fetchAdminAudit, refetchInterval: 8000 });

  return (
    <div className="space-y-5">
      <p className="text-[13.5px] text-ink-500 -mt-2">Who's using the platform, what they've run, and a full audit trail.</p>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Users" value={usage?.totals.users ?? 0} />
        <Stat label="Total actions" value={usage?.totals.actions ?? 0} />
        <Stat label="Sessions" value={usage?.totals.sessions ?? 0} />
      </div>

      <div className="flex gap-1 bg-canvas-raised border border-line rounded-xl p-1 w-fit shadow-card">
        {([{ id: "usage", label: "Per-user usage", icon: Users },
           { id: "audit", label: "Audit log", icon: ScrollText }] as const).map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors ${
                tab === t.id ? "bg-brand-500 text-white shadow-brand" : "text-ink-500 hover:text-ink-900 hover:bg-canvas-sunken"
              }`}>
              <Icon className="w-4 h-4" strokeWidth={2.2} />{t.label}
            </button>
          );
        })}
      </div>

      {tab === "usage" && (
        <div className="card card-pad">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-ink-400 border-b border-line">
                <th className="pb-2 font-semibold">User</th>
                <th className="pb-2 font-semibold">Simulations</th>
                <th className="pb-2 font-semibold">Total actions</th>
                <th className="pb-2 font-semibold text-right">Last active</th>
              </tr>
            </thead>
            <tbody>
              {(usage?.users ?? []).map(u => (
                <tr key={u.email} className="border-b border-line-soft">
                  <td className="py-2 font-semibold text-ink-700">{u.email}</td>
                  <td className="py-2">{u.simulations}</td>
                  <td className="py-2">{u.actions}</td>
                  <td className="py-2 text-right text-ink-400">{fmtAgo(Math.round(Date.now() / 1000 - u.last_seen))}</td>
                </tr>
              ))}
              {!usage?.users?.length && (
                <tr><td colSpan={4} className="py-6 text-center text-ink-400 italic">No usage yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "audit" && (
        <div className="card card-pad">
          <div className="space-y-1 max-h-[460px] overflow-auto">
            {(audit?.audit ?? []).map((a, i) => (
              <div key={i} className="flex items-center gap-3 text-[12px] py-1.5 border-b border-line-soft last:border-0">
                <span className="font-semibold text-ink-700 w-[220px] truncate flex-shrink-0">{a.email}</span>
                <span className="pill pill-neutral !py-0 !text-[10px]">{a.action}</span>
                <span className="text-ink-400 truncate flex-1">{a.detail}</span>
                <span className="text-ink-300 flex-shrink-0">{fmtAgo(a.ago_s)}</span>
              </div>
            ))}
            {!audit?.audit?.length && <div className="py-6 text-center text-ink-400 italic text-[13px]">No activity logged yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
