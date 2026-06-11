/**
 * RealOps — shared operational widgets for the real-phone platform:
 *   <IdentityBoard/>   patient test numbers with identity, busy, cooldown, registered state
 *   <SessionsExplorer/> filterable history of every real-phone session
 *   <RealInsights/>     engineering performance metrics dashboard
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRealConfig, fetchRealSessions, fetchRealInsights } from "../api";
import { RealSessionCard, REAL_TRIGGERS, fmtPhone } from "./RealSessionCard";

export function fmtCooldown(s: number): string {
  if (s <= 0) return "ready";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SCENARIO_LABELS: Record<string, string> = {
  "new-patient-cleaning": "🆕 New Patient – Cleaning",
  "dental-emergency": "🚨 Dental Emergency",
  "existing-routine": "📅 Existing – Routine",
  "reschedule": "🔄 Reschedule",
  "cancel": "❌ Cancel",
  "insurance-book": "🏥 Insurance → Book",
  "office-hours-book": "🕐 Office Hours → Book",
  "post-treatment-followup": "💊 Post-Treatment",
};

/* ── Identity board ────────────────────────────────────────────────────────── */

export function IdentityBoard({ env }: { env: string }) {
  const { data: cfg } = useQuery({ queryKey: ["realConfig"], queryFn: fetchRealConfig, refetchInterval: 15_000 });
  if (!cfg?.configured) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {cfg.patient_numbers.map(p => (
        <div key={p.number}
          className={`bg-white border rounded-xl px-3.5 py-2 text-[12px] ${p.busy ? "border-[#B5D4F5]" : "border-[#EAEAEA]"}`}>
          <span className="font-bold text-[#333]">{p.identity?.first} {p.identity?.last}</span>
          {p.busy && <span className="ml-1.5 text-[#1456A0] font-semibold">● in session</span>}
          <span className="block text-[#888] font-mono text-[11px]">{fmtPhone(p.number)}</span>
          <span className="block text-[10.5px] text-[#ADADAD]">
            SMS cooldown: {fmtCooldown(p.cooldowns?.[env] ?? 0)}
            {p.booked?.[env] ? " · ✓ registered patient" : " · not registered yet"}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Sessions explorer ─────────────────────────────────────────────────────── */

export function SessionsExplorer() {
  const [filterEnv, setFilterEnv] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const { data: sess } = useQuery({ queryKey: ["realSessions"], queryFn: fetchRealSessions, refetchInterval: 4000 });

  const filtered = (sess?.sessions ?? []).filter(s =>
    (filterEnv === "all" || s.env === filterEnv) &&
    (filterStatus === "all" || s.status === filterStatus)
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <select value={filterEnv} onChange={e => setFilterEnv(e.target.value)}
          className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] bg-white">
          <option value="all">All environments</option>
          <option value="beta">BETA</option>
          <option value="prod">PROD</option>
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] bg-white">
          <option value="all">All statuses</option>
          <option value="in_conversation">Conversing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <span className="text-[12.5px] text-[#888]">{filtered.length} session(s)</span>
      </div>
      {filtered.length === 0 && (
        <div className="text-[13px] text-[#ADADAD] italic bg-white border border-dashed border-[#EAEAEA] rounded-2xl p-8 text-center">
          No sessions yet — run a simulation and it will appear here.
        </div>
      )}
      {filtered.map(s => <RealSessionCard key={s.session_id} s={s} compact />)}
    </div>
  );
}

/* ── Insights ──────────────────────────────────────────────────────────────── */

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl p-4">
      <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide">{label}</div>
      <div className="text-[26px] font-extrabold text-[#111] mt-1">{value}</div>
      {sub && <div className="text-[11.5px] text-[#888]">{sub}</div>}
    </div>
  );
}

export function RealInsights() {
  const { data: ins } = useQuery({ queryKey: ["realInsights"], queryFn: fetchRealInsights, refetchInterval: 8000 });

  if (!ins || ins.total === 0) {
    return (
      <div className="text-[13px] text-[#ADADAD] italic bg-white border border-dashed border-[#EAEAEA] rounded-2xl p-8 text-center">
        No completed sessions yet — run a few simulations and engineering metrics will appear here.
      </div>
    );
  }

  const lat = ins.agent_reply_latency;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Sessions" value={ins.total} sub={`${ins.passed ?? 0} passed · ${ins.failed ?? 0} failed`} />
        <Stat label="Pass rate" value={`${ins.pass_rate ?? 0}%`} />
        <Stat label="Avg agent reply" value={`${lat?.avg_s ?? 0}s`} sub={`${lat?.samples ?? 0} turns measured`} />
        <Stat label="P95 agent reply" value={`${lat?.p95_s ?? 0}s`} sub={`max ${lat?.max_s ?? 0}s`} />
      </div>

      {ins.by_trigger && Object.keys(ins.by_trigger).length > 0 && (
        <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5">
          <div className="text-[13px] font-bold text-[#111] mb-3">Trigger engagement — how fast does the AI engage after each entry point?</div>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[#ADADAD] border-b border-[#EAEAEA]">
                <th className="pb-2 font-semibold">Trigger</th>
                <th className="pb-2 font-semibold">Runs</th>
                <th className="pb-2 font-semibold">Passed</th>
                <th className="pb-2 font-semibold">Avg time-to-first-SMS</th>
                <th className="pb-2 font-semibold">P95</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ins.by_trigger).map(([t, v]) => (
                <tr key={t} className="border-b border-[#F4F4F2]">
                  <td className="py-2 font-semibold text-[#333]">{REAL_TRIGGERS.find(x => x.id === t)?.label ?? t}</td>
                  <td className="py-2">{v.total}</td>
                  <td className="py-2">{v.passed}</td>
                  <td className="py-2">{v.avg_first_sms_latency_s > 0 ? `${v.avg_first_sms_latency_s}s` : "—"}</td>
                  <td className="py-2">{v.p95_first_sms_latency_s > 0 ? `${v.p95_first_sms_latency_s}s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ins.by_scenario && Object.keys(ins.by_scenario).length > 0 && (
        <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5">
          <div className="text-[13px] font-bold text-[#111] mb-3">Per-scenario quality</div>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[#ADADAD] border-b border-[#EAEAEA]">
                <th className="pb-2 font-semibold">Scenario</th>
                <th className="pb-2 font-semibold">Runs</th>
                <th className="pb-2 font-semibold">Passed</th>
                <th className="pb-2 font-semibold">Avg judge score</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ins.by_scenario).map(([id, v]) => (
                <tr key={id} className="border-b border-[#F4F4F2]">
                  <td className="py-2 font-semibold text-[#333]">{SCENARIO_LABELS[id] ?? id}</td>
                  <td className="py-2">{v.total}</td>
                  <td className="py-2">{v.passed}</td>
                  <td className="py-2">{v.avg_score > 0 ? `${v.avg_score}/100` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ins.failure_taxonomy && Object.keys(ins.failure_taxonomy).length > 0 && (
        <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5">
          <div className="text-[13px] font-bold text-[#111] mb-3">Failure taxonomy — what's breaking?</div>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(ins.failure_taxonomy).map(([k, v]) => (
              <span key={k} className="text-[12px] font-semibold bg-[#FEF2F2] text-[#991B1B] border border-[#FECACA] px-3 py-1.5 rounded-full">
                {k.replace(/_/g, " ")}: {v}
              </span>
            ))}
          </div>
          <div className="text-[11.5px] text-[#888] mt-2">
            no followup sms = AI never engaged after a call trigger · reply timeout = agent went silent &gt;90s mid-conversation
          </div>
        </div>
      )}
    </div>
  );
}
