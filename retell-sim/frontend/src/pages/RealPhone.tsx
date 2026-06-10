import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchRealConfig, fetchRealSessions, fetchRealSuites, fetchRealInsights,
  triggerReal, stopRealSession, setupRealWebhooks, runRealSuite,
  manualStart, manualSend, manualEnd,
} from "../api";
import type { RealSession } from "../api";

/* ── Constants ─────────────────────────────────────────────────────────────── */

const TRIGGERS = [
  { id: "missed_call",     icon: "📵", label: "Missed Call",
    desc: "Call rings, we hang up before answer. AI texts back." },
  { id: "incomplete_call", icon: "📞", label: "Incomplete Call",
    desc: "AI answers, we hang up mid-call. AI texts back." },
  { id: "inbound_sms",     icon: "💬", label: "Inbound SMS",
    desc: "Direct text. Needs no chat in last 24h on the number." },
  { id: "inbound_call",    icon: "🎙️", label: "Voice Call",
    desc: "Full live voice conversation with the AI Front Desk." },
] as const;

const SCENARIOS = [
  { id: "new-patient-cleaning",    label: "🆕 New Patient – Cleaning" },
  { id: "dental-emergency",        label: "🚨 Dental Emergency" },
  { id: "existing-routine",        label: "📅 Existing – Routine" },
  { id: "reschedule",              label: "🔄 Reschedule" },
  { id: "cancel",                  label: "❌ Cancel" },
  { id: "insurance-book",          label: "🏥 Insurance → Book" },
  { id: "office-hours-book",       label: "🕐 Office Hours → Book" },
  { id: "post-treatment-followup", label: "💊 Post-Treatment" },
];

const NEEDS_BOOKING = new Set(["existing-routine", "reschedule", "cancel", "post-treatment-followup"]);

const STATUS_STYLES: Record<string, string> = {
  starting:        "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]",
  calling:         "bg-[#EAF3FF] text-[#1456A0] border-[#B5D4F5]",
  waiting_for_sms: "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]",
  in_conversation: "bg-[#EAF3FF] text-[#1456A0] border-[#B5D4F5]",
  completed:       "bg-[#F2FDF4] text-[#166534] border-[#B8EFC8]",
  failed:          "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]",
};

const STATUS_LABEL: Record<string, string> = {
  starting: "starting", calling: "📞 calling", waiting_for_sms: "⏳ waiting for AI SMS",
  in_conversation: "💬 conversing", completed: "✓ completed", failed: "✗ failed",
};

function fmtCooldown(s: number): string {
  if (s <= 0) return "ready";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtPhone(n: string): string {
  const d = n.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n;
}

/* ── Session card ──────────────────────────────────────────────────────────── */

function SessionCard({ s, compact }: { s: RealSession; compact?: boolean }) {
  const [expanded, setExpanded] = useState(!compact);
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => stopRealSession(s.session_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["realSessions"] }),
  });
  const trig = TRIGGERS.find(t => t.id === s.trigger_type);
  const active = !["completed", "failed"].includes(s.status);

  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-2xl flex-shrink-0">{trig?.icon ?? "📱"}</span>
          <div className="min-w-0">
            <div className="text-[14.5px] font-bold text-[#111] truncate">
              {s.scenario_label || s.scenario_id}
              {s.mode === "manual" && <span className="ml-2 text-[10.5px] font-bold text-white bg-[#7C3AED] px-1.5 py-0.5 rounded">MANUAL</span>}
            </div>
            <div className="text-[12px] text-[#888] mt-0.5">
              <span className="font-semibold text-[#555]">{s.patient_name}</span>
              {" · "}{fmtPhone(s.patient_number)} → {fmtPhone(s.practice_number)}
              {" · "}<span className="uppercase font-semibold">{s.env}</span>
              {" · "}{trig?.label}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {s.first_sms_latency_s > 0 && (
            <span className="text-[11px] text-[#888] bg-[#F7F7F5] border border-[#EAEAEA] px-2 py-1 rounded-full"
                  title="Time from call end to first AI SMS">
              ⚡ engaged in {s.first_sms_latency_s}s
            </span>
          )}
          {s.avg_reply_latency_s > 0 && (
            <span className="text-[11px] text-[#888] bg-[#F7F7F5] border border-[#EAEAEA] px-2 py-1 rounded-full"
                  title="Average agent reply latency">
              ⏱ avg reply {s.avg_reply_latency_s}s
            </span>
          )}
          {s.score > 0 && (
            <span className={`text-[11.5px] font-bold px-2.5 py-1 rounded-full border ${
              s.score >= 80 ? "bg-[#F2FDF4] text-[#166534] border-[#B8EFC8]"
              : s.score >= 60 ? "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]"
              : "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]"
            }`} title={s.judge_reason}>
              {s.score}/100
            </span>
          )}
          {s.outcome && (
            <span className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border ${
              ["booking_confirmed", "task_created"].includes(s.outcome)
                ? "bg-[#F2FDF4] text-[#166534] border-[#B8EFC8]"
                : "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]"
            }`}>
              {s.outcome.replace(/_/g, " ")}
            </span>
          )}
          <span className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border ${STATUS_STYLES[s.status] ?? STATUS_STYLES.starting}`}>
            {active && <span className="inline-block w-[6px] h-[6px] bg-current rounded-full mr-1.5 animate-pulse" />}
            {STATUS_LABEL[s.status] ?? s.status}
          </span>
          {active && (
            <button onClick={() => stop.mutate()}
              className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-[#FECACA] bg-[#FEF2F2] text-[#991B1B] hover:bg-[#FEE2E2]">
              Stop
            </button>
          )}
          <button onClick={() => setExpanded(e => !e)} className="text-[13px] text-[#888] hover:text-[#333] px-1">
            {expanded ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {s.error && (
        <div className="mt-3 text-[12.5px] text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
          {s.error}
        </div>
      )}
      {s.status === "failed" && !s.error && s.events.length > 0 && (
        <div className="mt-3 text-[12.5px] text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
          {s.events[s.events.length - 1]?.msg}
        </div>
      )}

      {s.recording_url && (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[12px] font-semibold text-[#555]">🔊 Call recording ({s.recording_duration_s}s)</span>
          <audio controls preload="none" src={s.recording_url} className="h-9 flex-1 max-w-[420px]" />
        </div>
      )}

      {expanded && (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">
              Conversation ({s.turns.length})
            </div>
            {s.turns.length === 0 ? (
              <div className="text-[12.5px] text-[#ADADAD] italic">No messages yet…</div>
            ) : (
              <div className="space-y-2 max-h-[340px] overflow-auto pr-1">
                {s.turns.map((t, i) => (
                  <div key={i} className={`flex ${t.role === "patient" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] px-3 py-2 rounded-xl text-[13px] leading-snug ${
                      t.role === "patient"
                        ? "bg-brand-500 text-white rounded-br-sm"
                        : "bg-[#F4F4F2] text-[#222] rounded-bl-sm"
                    }`}>
                      <div className="text-[10px] opacity-70 mb-0.5">
                        {t.role === "patient" ? (s.mode === "manual" ? "You" : "Patient (sim)") : "AI Agent"}
                        {" · "}{t.channel}
                        {t.role === "agent" && t.latency_s > 0 && ` · ${t.latency_s}s`}
                      </div>
                      {t.message}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">Timeline</div>
            <div className="space-y-1.5 max-h-[340px] overflow-auto pr-1">
              {s.events.map((e, i) => (
                <div key={i} className="flex gap-2 text-[12px]">
                  <span className="text-[#ADADAD] flex-shrink-0 font-mono">
                    {new Date(e.ts * 1000).toLocaleTimeString()}
                  </span>
                  <span className="text-[#555]">{e.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── RUN section ───────────────────────────────────────────────────────────── */

function RunSection({ env }: { env: string }) {
  const qc = useQueryClient();
  const [trigger, setTrigger] = useState<string>("incomplete_call");
  const [selected, setSelected] = useState<Set<string>>(new Set(["new-patient-cleaning"]));
  const [msg, setMsg] = useState("");

  const { data: sess } = useQuery({ queryKey: ["realSessions"], queryFn: fetchRealSessions, refetchInterval: 2500 });
  const { data: suites } = useQuery({ queryKey: ["realSuites"], queryFn: fetchRealSuites, refetchInterval: 5000 });
  const activeSuite = suites?.suites?.find(s => s.status === "running");
  const activeSessions = sess?.sessions?.filter(s => !["completed", "failed"].includes(s.status)) ?? [];
  const recentDone = sess?.sessions?.filter(s => ["completed", "failed"].includes(s.status)).slice(0, 5) ?? [];

  const note = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 8000); };

  const single = useMutation({
    mutationFn: (scenarioId: string) =>
      triggerReal({ trigger_type: trigger, env, scenario_id: scenarioId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["realSessions"] }); note("✅ Launched"); },
    onError: (e: Error) => note(`❌ ${e.message}`),
  });

  const suite = useMutation({
    mutationFn: (kind: string) =>
      runRealSuite({
        kind,
        trigger_type: trigger,
        env,
        scenario_ids: kind === "suite" ? [...selected] : undefined,
      }),
    onSuccess: (_r, kind) => {
      qc.invalidateQueries({ queryKey: ["realSuites"] });
      note(kind === "journey"
        ? "✅ Patient Journey started: Book → Reschedule → Cancel with one identity"
        : `✅ Suite started — ${selected.size || 8} scenario(s) will run sequentially`);
    },
    onError: (e: Error) => note(`❌ ${e.message}`),
  });

  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="space-y-5">
      {/* Trigger picker */}
      <div>
        <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">1 · How should the conversation start?</div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {TRIGGERS.map(t => (
            <button key={t.id} onClick={() => setTrigger(t.id)}
              className={`text-left p-4 rounded-2xl border-2 transition-all ${
                trigger === t.id ? "border-brand-500 bg-white shadow-md" : "border-[#EAEAEA] bg-white hover:border-[#D5D5D5]"
              }`}>
              <div className="text-2xl mb-1.5">{t.icon}</div>
              <div className="text-[13.5px] font-bold text-[#111]">{t.label}</div>
              <div className="text-[11.5px] text-[#888] mt-1 leading-snug">{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Scenario grid */}
      <div>
        <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">
          2 · Pick scenarios <span className="normal-case font-normal">(▶ runs one now · checkbox selects for a suite)</span>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
          {SCENARIOS.map(sc => (
            <div key={sc.id}
              className={`flex items-center gap-2 p-3 rounded-xl border bg-white transition-colors ${
                selected.has(sc.id) ? "border-brand-500" : "border-[#EAEAEA]"
              }`}>
              <input type="checkbox" checked={selected.has(sc.id)} onChange={() => toggle(sc.id)}
                     className="accent-[#F5820D] w-4 h-4 flex-shrink-0" />
              <div className="text-[12.5px] font-semibold text-[#333] flex-1 leading-tight">
                {sc.label}
                {NEEDS_BOOKING.has(sc.id) && (
                  <span className="block text-[10px] text-[#92600A] font-normal">auto-books patient first if needed</span>
                )}
              </div>
              <button onClick={() => single.mutate(sc.id)} disabled={single.isPending}
                className="text-[15px] text-brand-500 hover:text-brand-600 disabled:opacity-40 flex-shrink-0"
                title="Run this one scenario now">▶</button>
            </div>
          ))}
        </div>
      </div>

      {/* Launch buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => suite.mutate("suite")}
          disabled={suite.isPending || !!activeSuite || selected.size === 0}
          className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13.5px] px-6 py-2.5 rounded-xl shadow-sm">
          {activeSuite ? `Suite running (${(activeSuite.current_idx ?? 0) + 1}/${activeSuite.total ?? "…"})` : `🚀 Run ${selected.size} selected`}
        </button>
        <button onClick={() => suite.mutate("journey")}
          disabled={suite.isPending || !!activeSuite}
          className="bg-white border-2 border-brand-500 text-brand-600 hover:bg-brand-50 disabled:opacity-40 font-bold text-[13.5px] px-5 py-2 rounded-xl"
          title="One patient identity: book a new appointment, then reschedule it, then cancel it">
          🧭 Patient Journey (Book → Reschedule → Cancel)
        </button>
        {msg && <span className="text-[12.5px] font-medium text-[#555]">{msg}</span>}
      </div>

      {/* Suite progress */}
      {(suites?.suites?.length ?? 0) > 0 && (
        <div className="space-y-2">
          {suites!.suites.slice(0, 4).map(su => (
            <div key={su.suite_id} className="bg-white border border-[#EAEAEA] rounded-xl px-4 py-2.5 flex items-center gap-4 text-[12.5px] flex-wrap">
              <span className="font-bold text-[#333]">{su.kind === "journey" ? "🧭 Journey" : "🧪 Suite"} {su.suite_id}</span>
              <span className="text-[#888]">{su.env.toUpperCase()} · {su.trigger_type.replace(/_/g, " ")}</span>
              {su.status === "running" ? (
                <span className="text-[#1456A0] font-semibold">
                  <span className="inline-block w-[6px] h-[6px] bg-current rounded-full mr-1.5 animate-pulse" />
                  scenario {(su.current_idx ?? 0) + 1} of {su.total ?? su.scenario_ids.length}
                </span>
              ) : (
                <span className="font-semibold">
                  <span className="text-[#166534]">{su.passed ?? 0} passed</span>{" · "}
                  <span className="text-[#991B1B]">{su.failed ?? 0} failed</span>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Live sessions */}
      {activeSessions.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide">Live now</div>
          {activeSessions.map(s => <SessionCard key={s.session_id} s={s} />)}
        </div>
      )}

      {/* Recent results */}
      {recentDone.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide">Recent results</div>
          {recentDone.map(s => <SessionCard key={s.session_id} s={s} compact />)}
        </div>
      )}
    </div>
  );
}

/* ── MANUAL section ────────────────────────────────────────────────────────── */

function ManualSection({ env }: { env: string }) {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [starter, setStarter] = useState("Hi, I'd like to book an appointment");
  const [callTrigger, setCallTrigger] = useState<string>("incomplete_call");
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: sess } = useQuery({
    queryKey: ["realSessions"], queryFn: fetchRealSessions,
    refetchInterval: sessionId ? 2000 : 5000,
  });
  const session = sess?.sessions?.find(s => s.session_id === sessionId);
  const active = session && !["completed", "failed"].includes(session.status);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [session?.turns?.length]);

  const start = useMutation({
    mutationFn: (kind: "sms" | "call") =>
      manualStart({
        env,
        trigger_type: kind === "sms" ? "inbound_sms" : callTrigger,
        message: kind === "sms" ? starter : "",
      }),
    onSuccess: r => { setSessionId(r.session.session_id); qc.invalidateQueries({ queryKey: ["realSessions"] }); },
  });

  const send = useMutation({
    mutationFn: () => manualSend({ session_id: sessionId, message: draft }),
    onSuccess: () => { setDraft(""); qc.invalidateQueries({ queryKey: ["realSessions"] }); },
  });

  const end = useMutation({
    mutationFn: () => manualEnd(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["realSessions"] }),
  });

  return (
    <div className="space-y-5">
      <div className="bg-[#EAF3FF] border border-[#B5D4F5] rounded-2xl p-4 text-[13px] text-[#1456A0]">
        <b>You drive the conversation.</b> The platform sends real SMS from a test number — you type each
        message, the AI agent replies for real, everything lands in the ADIT app. No personal phone needed.
      </div>

      {!session && (
        <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5 space-y-4">
          <div>
            <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">Start with an SMS</div>
            <div className="flex gap-3 flex-wrap">
              <input value={starter} onChange={e => setStarter(e.target.value)}
                className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] flex-1 min-w-[280px]" />
              <button onClick={() => start.mutate("sms")} disabled={start.isPending || !starter.trim()}
                className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13px] px-5 py-2 rounded-xl">
                💬 Send first SMS
              </button>
            </div>
            <div className="text-[11.5px] text-[#92600A] mt-1.5">
              ⚠️ Only engages if the test number had no conversation in the last 24h — prefer a call trigger otherwise.
            </div>
          </div>
          <div className="border-t border-[#EAEAEA] pt-4">
            <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">…or start with a call (always engages)</div>
            <div className="flex gap-3 items-center flex-wrap">
              <select value={callTrigger} onChange={e => setCallTrigger(e.target.value)}
                className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] bg-white">
                <option value="incomplete_call">📞 Incomplete call (AI answers, we hang up)</option>
                <option value="missed_call">📵 Missed call (hang up while ringing)</option>
              </select>
              <button onClick={() => start.mutate("call")} disabled={start.isPending}
                className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13px] px-5 py-2 rounded-xl">
                📞 Place call — then I'll text manually
              </button>
            </div>
          </div>
        </div>
      )}

      {session && (
        <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="text-[13px]">
              <span className="font-bold text-[#111]">{session.patient_name}</span>
              <span className="text-[#888]"> · {fmtPhone(session.patient_number)} → {fmtPhone(session.practice_number)} · {session.env.toUpperCase()}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border ${STATUS_STYLES[session.status]}`}>
                {STATUS_LABEL[session.status] ?? session.status}
              </span>
              {active && (
                <button onClick={() => end.mutate()}
                  className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]">
                  End session
                </button>
              )}
              <button onClick={() => setSessionId("")}
                className="text-[11.5px] text-[#888] underline">New session</button>
            </div>
          </div>

          <div className="bg-[#FAFAF8] rounded-xl p-4 h-[380px] overflow-auto space-y-2">
            {session.turns.length === 0 && (
              <div className="text-[12.5px] text-[#ADADAD] italic text-center mt-8">
                {session.status === "calling" ? "Call in progress…" :
                 session.status === "waiting_for_sms" ? "Call done — waiting for the AI to text back…" :
                 "No messages yet"}
              </div>
            )}
            {session.turns.map((t, i) => (
              <div key={i} className={`flex ${t.role === "patient" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[75%] px-3.5 py-2 rounded-2xl text-[13.5px] leading-snug ${
                  t.role === "patient" ? "bg-brand-500 text-white rounded-br-md" : "bg-white border border-[#EAEAEA] text-[#222] rounded-bl-md"
                }`}>
                  {t.message}
                  {t.role === "agent" && t.latency_s > 0 && (
                    <div className="text-[10px] opacity-60 mt-0.5">{t.latency_s}s</div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="flex gap-2 mt-3">
            <input value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && draft.trim() && active) send.mutate(); }}
              placeholder={active ? "Type your message as the patient…" : "Session ended"}
              disabled={!active}
              className="border border-[#EAEAEA] rounded-xl px-4 py-2.5 text-[13.5px] flex-1 disabled:bg-[#F7F7F5]" />
            <button onClick={() => send.mutate()} disabled={!active || !draft.trim() || send.isPending}
              className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13.5px] px-6 py-2.5 rounded-xl">
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── SESSIONS section ─────────────────────────────────────────────────────── */

function SessionsSection() {
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
          No sessions match. Sessions reset on each deploy.
        </div>
      )}
      {filtered.map(s => <SessionCard key={s.session_id} s={s} compact />)}
    </div>
  );
}

/* ── INSIGHTS section ─────────────────────────────────────────────────────── */

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl p-4">
      <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide">{label}</div>
      <div className="text-[26px] font-extrabold text-[#111] mt-1">{value}</div>
      {sub && <div className="text-[11.5px] text-[#888]">{sub}</div>}
    </div>
  );
}

function InsightsSection() {
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

      {/* Trigger engagement */}
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
                  <td className="py-2 font-semibold text-[#333]">{TRIGGERS.find(x => x.id === t)?.label ?? t}</td>
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

      {/* Per-scenario */}
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
                  <td className="py-2 font-semibold text-[#333]">{SCENARIOS.find(x => x.id === id)?.label ?? id}</td>
                  <td className="py-2">{v.total}</td>
                  <td className="py-2">{v.passed}</td>
                  <td className="py-2">{v.avg_score > 0 ? `${v.avg_score}/100` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Failure taxonomy */}
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

/* ── Page shell ────────────────────────────────────────────────────────────── */

const SECTIONS = [
  { id: "run",      label: "🚀 Run" },
  { id: "manual",   label: "✍️ Manual" },
  { id: "sessions", label: "🗂 Sessions" },
  { id: "insights", label: "📊 Insights" },
] as const;

export function RealPhone() {
  const [section, setSection] = useState<string>("run");
  const [env, setEnv] = useState("beta");
  const { data: cfg } = useQuery({ queryKey: ["realConfig"], queryFn: fetchRealConfig, refetchInterval: 30_000 });
  const setup = useMutation({ mutationFn: setupRealWebhooks });

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-[19px] font-extrabold text-[#111]">📱 Real Phone Testing</h2>
          <p className="text-[13px] text-[#888] mt-1 max-w-[640px]">
            Real calls and SMS from dedicated test numbers — the full patient path. Every conversation
            registers in the ADIT app with all dynamic variables, exactly like a real patient.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(["beta", "prod"] as const).map(e => (
            <button key={e} onClick={() => setEnv(e)}
              className={`text-[12.5px] font-bold px-4 py-2 rounded-xl border-2 transition-all ${
                env === e ? "border-brand-500 bg-white text-[#111] shadow-sm" : "border-[#EAEAEA] bg-white text-[#888]"
              }`}>
              {e.toUpperCase()}
              <span className="block text-[10.5px] font-normal text-[#ADADAD]">
                {cfg?.practice_numbers?.[e] ? fmtPhone(cfg.practice_numbers[e]) : "—"}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Not configured */}
      {cfg && !cfg.configured && (
        <div className="bg-[#FFF7E6] border border-[#F5D998] rounded-2xl p-5">
          <div className="text-[14px] font-bold text-[#92600A]">Twilio not configured</div>
          <div className="text-[13px] text-[#92600A] mt-1">
            Set <code className="font-mono bg-white/60 px-1 rounded">TWILIO_ACCOUNT_SID</code> and{" "}
            <code className="font-mono bg-white/60 px-1 rounded">TWILIO_AUTH_TOKEN</code> in Railway, then{" "}
            <button onClick={() => setup.mutate()} className="underline font-semibold">configure webhooks</button>.
          </div>
        </div>
      )}

      {/* Patient identity board */}
      {cfg?.configured && (
        <div className="flex flex-wrap gap-2">
          {cfg.patient_numbers.map(p => (
            <div key={p.number}
              className={`bg-white border rounded-xl px-3.5 py-2 text-[12px] ${p.busy ? "border-[#B5D4F5]" : "border-[#EAEAEA]"}`}>
              <span className="font-bold text-[#333]">
                {p.identity?.first} {p.identity?.last}
              </span>
              {p.busy && <span className="ml-1.5 text-[#1456A0] font-semibold">● on a call/chat</span>}
              <span className="block text-[#888] font-mono text-[11px]">{fmtPhone(p.number)}</span>
              <span className="block text-[10.5px] text-[#ADADAD]">
                {Object.entries(p.cooldowns ?? {}).map(([e, s]) => `${e}: ${fmtCooldown(s as number)}`).join(" · ")}
                {p.booked?.[env] ? " · ✓ registered" : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Section tabs */}
      <div className="flex gap-1 bg-white border border-[#EAEAEA] rounded-xl p-1 w-fit">
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors ${
              section === s.id ? "bg-brand-500 text-white" : "text-[#888] hover:text-[#333]"
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {section === "run"      && <RunSection env={env} />}
      {section === "manual"   && <ManualSection env={env} />}
      {section === "sessions" && <SessionsSection />}
      {section === "insights" && <InsightsSection />}
    </div>
  );
}
