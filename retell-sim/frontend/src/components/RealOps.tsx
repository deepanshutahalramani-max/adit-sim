/**
 * RealOps — shared operational widgets for the real-phone platform:
 *   <IdentityBoard/>   patient test numbers with identity, busy, cooldown, registered state
 *   <SessionsExplorer/> filterable history of every real-phone session
 *   <RealInsights/>     engineering performance metrics dashboard
 */
import { useState, useRef } from "react";
import { Paperclip } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchRealConfig, fetchRealSessions, fetchRealInsights, fetchApiMetrics, fetchEhrMetrics, reanalyzeFeedback, fetchTrends, extractContextFromImage } from "../api";
import { RealSessionCard, REAL_TRIGGERS, fmtPhone } from "./RealSessionCard";

/* ── Scenario context: free-text + screenshot OCR for the AI patient ───────── */
export function ContextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (f: File) => {
    setBusy(true); setErr("");
    try {
      const { context } = await extractContextFromImage(f);
      onChange(value ? `${value.trim()}\n\n[From screenshot]\n${context}` : context);
    } catch (e) {
      setErr((e as Error).message || "Could not read the screenshot.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="section-label">
          Scenario context <span className="text-ink-300 normal-case font-medium tracking-normal">optional</span>
        </span>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-40"
        >
          <Paperclip className="w-3.5 h-3.5" strokeWidth={2} />
          {busy ? "Reading screenshot…" : "Add screenshot"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={3}
        placeholder="Tell the AI patient who they are and what they want — e.g. 'Anxious new patient, United Concordia insurance, tooth pain, wants the earliest morning slot this week.' Or drop a screenshot and we'll read it."
        className="field resize-none !text-[12.5px] leading-relaxed"
      />
      {err && <div className="text-[11.5px] text-[#B91C1C] mt-1.5">{err}</div>}
      <div className="text-[11px] text-ink-400 mt-1.5">
        The patient brain uses this to stay in character — it does not change scheduling logic.
      </div>
    </div>
  );
}

/* ── Self-improving feedback: comment on an issue → LLM re-analysis ─────────── */
function IssueFeedback({ issueTitle, sessionId }: { issueTitle: string; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [refined, setRefined] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!comment.trim()) return;
    setBusy(true); setErr("");
    try {
      const r = await reanalyzeFeedback({ issue_title: issueTitle, session_id: sessionId, comment });
      setRefined(r.refined_analysis);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Re-analysis failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-2">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-[11.5px] font-semibold text-brand-600 hover:text-brand-700">
          💬 Add a comment / re-analyze
        </button>
      ) : (
        <div className="space-y-2">
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
            placeholder="Add your insight (e.g. 'this is a prompt bug — agent must re-fetch slots after the patient-type flip'). The platform re-reads the conversation with your note."
            className="field !text-[12px] resize-none" />
          <div className="flex gap-2">
            <button onClick={submit} disabled={busy || !comment.trim()} className="btn-primary btn-sm">
              {busy ? "Re-analyzing…" : "🤖 Re-analyze with my note"}
            </button>
            <button onClick={() => setOpen(false)} className="btn-ghost btn-sm">Cancel</button>
          </div>
          {err && <div className="text-[11.5px] text-[#B91C1C]">{err}</div>}
          {refined && (
            <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5">
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-brand-700 mb-1">Refined analysis</div>
              <div className="text-[12px] text-ink-700 leading-snug">{refined}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function fmtCooldown(s: number): string {
  if (s <= 0) return "ready";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ── Trends & run comparison ─────────────────────────────────────────────────── */
export function TrendsView() {
  const { data: t } = useQuery({ queryKey: ["trends"], queryFn: fetchTrends, refetchInterval: 15000 });
  if (!t || (t.days?.length ?? 0) === 0) {
    return (
      <div className="text-[13px] text-ink-400 italic card card-pad text-center py-10 border-dashed">
        No trend data yet — run a few suites and pass-rate / score over time will appear here (needs Supabase).
      </div>
    );
  }
  const maxRate = 100;
  return (
    <div className="space-y-5">
      {/* Daily trend */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">Pass rate over time (daily)</div>
        <div className="flex items-end gap-2 h-[160px]">
          {t.days.map(d => (
            <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-1 group">
              <div className="text-[10px] text-ink-400">{d.pass_rate}%</div>
              <div className="w-full rounded-t-md bg-brand-500/80 group-hover:bg-brand-500 transition-colors"
                   style={{ height: `${Math.max(4, (d.pass_rate / maxRate) * 120)}px` }}
                   title={`${d.date}: ${d.passed}/${d.total} passed · avg ${d.avg_score}`} />
              <div className="text-[9px] text-ink-300 rotate-0">{d.date.slice(5)}</div>
            </div>
          ))}
        </div>
        <div className="text-[11px] text-ink-400 mt-2">Bar = daily pass rate · hover for counts + avg judge score.</div>
      </div>

      {/* Run-over-run comparison */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">Recent suites — run-over-run</div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-ink-400 border-b border-line">
              <th className="pb-2 font-semibold">Suite</th>
              <th className="pb-2 font-semibold">Env</th>
              <th className="pb-2 font-semibold">Scenarios</th>
              <th className="pb-2 font-semibold">Passed</th>
              <th className="pb-2 font-semibold">Pass rate</th>
              <th className="pb-2 font-semibold text-right">Avg score</th>
            </tr>
          </thead>
          <tbody>
            {t.suites.map(s => (
              <tr key={s.suite_id} className="border-b border-line-soft">
                <td className="py-2 font-mono text-ink-700">{s.suite_id}</td>
                <td className="py-2 uppercase text-ink-500">{s.env}</td>
                <td className="py-2">{s.total}</td>
                <td className="py-2">{s.passed}</td>
                <td className={`py-2 font-bold ${s.pass_rate >= 80 ? "text-[#15803D]" : s.pass_rate >= 50 ? "text-[#B45309]" : "text-[#B91C1C]"}`}>{s.pass_rate}%</td>
                <td className="py-2 text-right">{s.avg_score || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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

function Stat({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div className="card card-pad !p-4">
      <div className="section-label">{label}</div>
      <div className={`text-[26px] font-extrabold mt-1 ${accent ?? "text-ink-900"}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}

const PROVIDER_TONE: Record<string, string> = {
  Twilio: "bg-[#F22F46]", RingCentral: "bg-[#FF8800]", OpenAI: "bg-[#10A37F]",
};

function latencyTone(ms: number): string {
  if (ms <= 0) return "text-ink-400";
  if (ms < 1500) return "text-[#15803D]";
  if (ms < 4000) return "text-[#B45309]";
  return "text-[#B91C1C]";
}

/* ── API performance dashboard ─────────────────────────────────────────────── */

export function ApiPerformance() {
  const { data: m } = useQuery({ queryKey: ["apiMetrics"], queryFn: fetchApiMetrics, refetchInterval: 5000 });

  if (!m || m.total === 0) {
    return (
      <div className="text-[13px] text-ink-400 italic card card-pad text-center py-10 border-dashed">
        No API calls recorded yet — run a simulation and every meaningful call (Twilio, RingCentral, OpenAI)
        will be measured here with latency, error rate, and cost.
      </div>
    );
  }

  const providers = Object.entries(m.providers);
  return (
    <div className="space-y-5">
      {/* Totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="API calls" value={m.total.toLocaleString()} sub="meaningful calls only" />
        <Stat label="Errors" value={m.total_errors}
          sub={`${m.total ? Math.round(100 * m.total_errors / m.total) : 0}% error rate`}
          accent={m.total_errors > 0 ? "text-[#B91C1C]" : "text-ink-900"} />
        <Stat label="Est. spend" value={`$${m.total_cost.toFixed(2)}`} sub="Twilio + OpenAI" />
        <Stat label="Providers" value={providers.length} sub={providers.map(p => p[0]).join(" · ")} />
      </div>

      {/* By provider */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">By provider</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {providers.map(([name, p]) => (
            <div key={name} className="border border-line rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2.5">
                <span className={`w-2.5 h-2.5 rounded-full ${PROVIDER_TONE[name] ?? "bg-ink-400"}`} />
                <span className="text-[13.5px] font-bold text-ink-900">{name}</span>
                <span className="text-[11.5px] text-ink-400 ml-auto">{p.count} calls</span>
              </div>
              <div className="grid grid-cols-2 gap-y-2 text-[12px]">
                <div><div className="text-ink-400">Avg latency</div><div className={`font-bold ${latencyTone(p.avg_ms)}`}>{p.avg_ms} ms</div></div>
                <div><div className="text-ink-400">P95 latency</div><div className={`font-bold ${latencyTone(p.p95_ms)}`}>{p.p95_ms} ms</div></div>
                <div><div className="text-ink-400">Error rate</div><div className={`font-bold ${p.error_rate > 0 ? "text-[#B91C1C]" : "text-[#15803D]"}`}>{p.error_rate}%</div></div>
                <div><div className="text-ink-400">Spend</div><div className="font-bold text-ink-900">${p.cost.toFixed(3)}</div></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* By operation */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">By operation</div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-ink-400 border-b border-line">
              <th className="pb-2 font-semibold">Operation</th>
              <th className="pb-2 font-semibold">Calls</th>
              <th className="pb-2 font-semibold">Avg</th>
              <th className="pb-2 font-semibold">P95</th>
              <th className="pb-2 font-semibold">Errors</th>
              <th className="pb-2 font-semibold text-right">Spend</th>
            </tr>
          </thead>
          <tbody>
            {m.operations.map((o, i) => (
              <tr key={i} className="border-b border-line-soft">
                <td className="py-2">
                  <span className="font-semibold text-ink-700">{o.provider}</span>
                  <span className="text-ink-400"> · {o.operation}</span>
                </td>
                <td className="py-2">{o.count}</td>
                <td className={`py-2 font-medium ${latencyTone(o.avg_ms)}`}>{o.avg_ms ? `${o.avg_ms} ms` : "—"}</td>
                <td className={`py-2 font-medium ${latencyTone(o.p95_ms)}`}>{o.p95_ms ? `${o.p95_ms} ms` : "—"}</td>
                <td className={`py-2 ${o.errors > 0 ? "text-[#B91C1C] font-semibold" : "text-ink-400"}`}>{o.errors || "—"}</td>
                <td className="py-2 text-right">{o.cost > 0 ? `$${o.cost.toFixed(3)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Live call feed */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">Recent API calls</div>
        <div className="space-y-1 max-h-[300px] overflow-auto">
          {m.recent.map((r, i) => (
            <div key={i} className="flex items-center gap-3 text-[12px] py-1 border-b border-line-soft last:border-0">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.ok ? "bg-[#22C55E]" : "bg-[#EF4444]"}`} />
              <span className="font-semibold text-ink-700 w-[90px] flex-shrink-0">{r.provider}</span>
              <span className="text-ink-500 w-[120px] flex-shrink-0">{r.operation.replace(/_/g, " ")}</span>
              <span className={`font-medium w-[64px] flex-shrink-0 ${latencyTone(r.latency_ms)}`}>{r.latency_ms ? `${r.latency_ms}ms` : "—"}</span>
              {r.env && <span className="pill pill-neutral !py-0 !text-[10px] uppercase">{r.env}</span>}
              <span className="text-ink-300 truncate flex-1">{r.detail}</span>
              <span className="text-ink-300 flex-shrink-0">{r.ago_s}s ago</span>
            </div>
          ))}
        </div>
      </div>
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
        <div className="card card-pad">
          <div className="text-[13px] font-bold text-ink-900 mb-3">Trigger engagement — how fast does the AI engage after each entry point?</div>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-ink-400 border-b border-line">
                <th className="pb-2 font-semibold">Trigger</th>
                <th className="pb-2 font-semibold">Runs</th>
                <th className="pb-2 font-semibold">Passed</th>
                <th className="pb-2 font-semibold">Avg time-to-first-SMS</th>
                <th className="pb-2 font-semibold">P95</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ins.by_trigger).map(([t, v]) => (
                <tr key={t} className="border-b border-line-soft">
                  <td className="py-2 font-semibold text-ink-700">{REAL_TRIGGERS.find(x => x.id === t)?.label ?? t}</td>
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
        <div className="card card-pad">
          <div className="text-[13px] font-bold text-ink-900 mb-3">Per-scenario quality</div>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-ink-400 border-b border-line">
                <th className="pb-2 font-semibold">Scenario</th>
                <th className="pb-2 font-semibold">Runs</th>
                <th className="pb-2 font-semibold">Passed</th>
                <th className="pb-2 font-semibold">Avg judge score</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ins.by_scenario).map(([id, v]) => (
                <tr key={id} className="border-b border-line-soft">
                  <td className="py-2 font-semibold text-ink-700">{SCENARIO_LABELS[id] ?? id}</td>
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
        <div className="card card-pad">
          <div className="text-[13px] font-bold text-ink-900 mb-3">Failure taxonomy — what's breaking?</div>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(ins.failure_taxonomy).map(([k, v]) => (
              <span key={k} className="text-[12px] font-semibold bg-[#FEF2F2] text-[#991B1B] border border-[#FECACA] px-3 py-1.5 rounded-full">
                {k.replace(/_/g, " ")}: {v}
              </span>
            ))}
          </div>
          <div className="text-[11.5px] text-ink-400 mt-2">
            no followup sms = AI never engaged after a call trigger · reply timeout = agent went silent &gt;90s mid-conversation
          </div>
        </div>
      )}

      {(ins.not_testable ?? 0) > 0 && (
        <div className="card card-pad bg-canvas-sunken">
          <div className="text-[12.5px] text-ink-500">
            <b>{ins.not_testable}</b> session(s) excluded from scoring — the agent reported no EHR/system
            access, so booking/reschedule/cancel can't be tested there (not connected practice).
          </div>
        </div>
      )}
    </div>
  );
}

/* ── EHR / agent API flow (from Retell tool-call logs) ─────────────────────── */

const EHR_ORDER = [
  "create_new_patient", "fetch_patient_details", "upcoming_appointments",
  "get_available_slot", "get_rescheduling_slots", "book_appointment",
  "modify_appointment", "provider_list", "create_task",
];

export function EhrApiFlow() {
  const { data: m } = useQuery({ queryKey: ["ehrMetrics"], queryFn: fetchEhrMetrics, refetchInterval: 6000 });

  if (!m || m.total === 0) {
    return (
      <div className="text-[13px] text-ink-400 italic card card-pad text-center py-10 border-dashed">
        No EHR function calls captured yet. Run a scenario on a connected practice (e.g. PROD) — the agent's
        create_new_patient / get_available_slot / book_appointment / create_task calls are pulled from Retell
        and measured here with success vs failure and latency.
      </div>
    );
  }

  const fns = [...m.functions].sort(
    (a, b) => EHR_ORDER.indexOf(a.name) - EHR_ORDER.indexOf(b.name));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="EHR calls" value={m.total} sub="agent → ADIT functions" />
        <Stat label="Business failures" value={m.total_failures ?? 0}
          accent={(m.total_failures ?? 0) > 0 ? "text-[#B91C1C]" : "text-ink-900"}
          sub="e.g. booking rejected" />
        <Stat label="Functions used" value={m.functions.length} />
        <Stat label="Success rate"
          value={`${m.total ? Math.round(100 * (m.total - (m.total_failures ?? 0)) / m.total) : 0}%`} />
      </div>

      {/* Auto-diagnosed root causes */}
      {(m.issues?.length ?? 0) > 0 && (
        <div className="card card-pad">
          <div className="text-[13px] font-bold text-ink-900 mb-1">🔎 Issues detected — root cause</div>
          <div className="text-[11.5px] text-ink-400 mb-3">
            The platform analyzes the EHR call sequence and explains what went wrong, not just that it failed.
          </div>
          <div className="space-y-2">
            {m.issues!.map((iss, i) => (
              <div key={i} className={`rounded-xl border px-4 py-3 ${
                iss.severity === "high" ? "border-[#FECACA] bg-[#FEF2F2]" : "border-[#FED7AA] bg-[#FFF7ED]"
              }`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[12.5px] font-bold ${iss.severity === "high" ? "text-[#B91C1C]" : "text-[#B45309]"}`}>
                    {iss.title}
                  </span>
                  <span className={`pill !py-0 !text-[10px] ${iss.severity === "high" ? "pill-bad" : "pill-warn"}`}>{iss.severity}</span>
                  {iss.env && <span className="pill pill-neutral !py-0 !text-[10px] uppercase">{iss.env}</span>}
                  <span className="text-[10.5px] text-ink-300 ml-auto">{iss.ago_s}s ago</span>
                </div>
                <div className="text-[12px] text-ink-500 mt-1 leading-snug">{iss.detail}</div>
                <IssueFeedback issueTitle={iss.title} sessionId={iss.scenario_id} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-function */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">EHR functions — the booking-flow APIs</div>
        <div className="space-y-2.5">
          {fns.map(f => {
            const failPct = f.count ? (f.failures / f.count) * 100 : 0;
            return (
              <div key={f.name} className="flex items-center gap-3">
                <div className="w-[170px] flex-shrink-0">
                  <div className="text-[12.5px] font-semibold text-ink-700">{f.label}</div>
                  <div className="text-[10.5px] text-ink-400 font-mono">{f.name}</div>
                </div>
                {/* success/fail bar */}
                <div className="flex-1 h-6 rounded-lg overflow-hidden bg-canvas-sunken flex">
                  <div className="h-full bg-[#86EFAC] flex items-center justify-end pr-2" style={{ width: `${100 - failPct}%` }}>
                    {f.success > 0 && <span className="text-[10px] font-bold text-[#15803D]">{f.success}</span>}
                  </div>
                  {f.failures > 0 && (
                    <div className="h-full bg-[#FCA5A5] flex items-center justify-start pl-2" style={{ width: `${failPct}%` }}>
                      <span className="text-[10px] font-bold text-[#B91C1C]">{f.failures}</span>
                    </div>
                  )}
                </div>
                <div className="w-[120px] flex-shrink-0 text-right text-[11.5px]">
                  <span className={`font-bold ${f.success_rate >= 90 ? "text-[#15803D]" : f.success_rate >= 60 ? "text-[#B45309]" : "text-[#B91C1C]"}`}>
                    {f.success_rate}%
                  </span>
                  <span className="text-ink-400"> · {f.count}× · {f.avg_ms}ms</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-[11px] text-ink-400 mt-3">
          Green = business success · Red = business failure (e.g. <code>book_appointment</code> returning
          "slot no longer available"). Pulled live from the Retell agent's tool-call logs.
        </div>
      </div>

      {/* Recent calls */}
      <div className="card card-pad">
        <div className="text-[13px] font-bold text-ink-900 mb-3">Recent EHR calls</div>
        <div className="space-y-1 max-h-[300px] overflow-auto">
          {m.recent.map((r, i) => (
            <div key={i} className="flex items-center gap-3 text-[12px] py-1 border-b border-line-soft last:border-0">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.business_ok ? "bg-[#22C55E]" : "bg-[#EF4444]"}`} />
              <span className="font-mono font-semibold text-ink-700 w-[160px] flex-shrink-0">{r.name}</span>
              {r.env && <span className="pill pill-neutral !py-0 !text-[10px] uppercase">{r.env}</span>}
              <span className={`font-medium w-[36px] ${r.business_ok ? "text-[#15803D]" : "text-[#B91C1C]"}`}>{r.business_ok ? "ok" : "fail"}</span>
              <span className="text-ink-500 font-medium w-[56px] flex-shrink-0">⏱ {r.latency_ms}ms</span>
              <span className="text-ink-300 truncate flex-1">{r.result}</span>
              <span className="text-ink-300 flex-shrink-0">{r.ago_s}s</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
