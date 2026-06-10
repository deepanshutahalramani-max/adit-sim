import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchRealConfig, fetchRealSessions, triggerReal, stopRealSession, setupRealWebhooks,
  runRealSuite, fetchRealSuites,
} from "../api";
import type { RealSession } from "../api";

const TRIGGERS = [
  {
    id: "missed_call",
    icon: "📵",
    label: "Missed Call",
    desc: "Real call to the practice, cancelled while ringing. AI sends a follow-up SMS and the platform converses automatically.",
  },
  {
    id: "incomplete_call",
    icon: "📞",
    label: "Incomplete Call",
    desc: "Real call — AI answers, we hang up mid-call. AI sends a follow-up SMS and the platform takes over the conversation.",
  },
  {
    id: "inbound_sms",
    icon: "💬",
    label: "Inbound SMS",
    desc: "Real text to the practice number. Only engages if this number had no conversation in the last 24 hours.",
  },
  {
    id: "inbound_call",
    icon: "🎙️",
    label: "Inbound Call (Voice)",
    desc: "Real call — AI Front Desk answers and the platform holds a full voice conversation (speech-to-text ↔ TTS).",
  },
] as const;

const SCENARIOS = [
  { id: "new-patient-cleaning",    label: "🆕 New Patient – Cleaning" },
  { id: "dental-emergency",        label: "🚨 Dental Emergency" },
  { id: "existing-routine",        label: "📅 Existing Patient – Routine" },
  { id: "reschedule",              label: "🔄 Reschedule Appointment" },
  { id: "cancel",                  label: "❌ Cancel Appointment" },
  { id: "insurance-book",          label: "🏥 Insurance Check → Book" },
  { id: "office-hours-book",       label: "🕐 Office Hours → Book" },
  { id: "post-treatment-followup", label: "💊 Post-Treatment Follow-up" },
];

const STATUS_STYLES: Record<string, string> = {
  starting:        "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]",
  calling:         "bg-[#EAF3FF] text-[#1456A0] border-[#B5D4F5]",
  waiting_for_sms: "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]",
  in_conversation: "bg-[#EAF3FF] text-[#1456A0] border-[#B5D4F5]",
  completed:       "bg-[#F2FDF4] text-[#166534] border-[#B8EFC8]",
  failed:          "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]",
};

function fmtCooldown(s: number): string {
  if (s <= 0) return "ready";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m cooldown` : `${m}m cooldown`;
}

function SessionCard({ s }: { s: RealSession }) {
  const [expanded, setExpanded] = useState(true);
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
        <div className="flex items-center gap-3">
          <span className="text-2xl">{trig?.icon ?? "📱"}</span>
          <div>
            <div className="text-[14.5px] font-bold text-[#111]">
              {trig?.label ?? s.trigger_type}
              <span className="text-[#ADADAD] font-normal"> · {s.scenario_label || s.scenario_id}</span>
            </div>
            <div className="text-[12px] text-[#888] mt-0.5">
              {s.patient_number} → {s.practice_number}
              {s.call_status && <span className="ml-2 text-[#ADADAD]">call: {s.call_status}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
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
            {s.status.replace(/_/g, " ")}
          </span>
          {active && (
            <button
              onClick={() => stop.mutate()}
              className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-[#FECACA] bg-[#FEF2F2] text-[#991B1B] hover:bg-[#FEE2E2]"
            >
              Stop
            </button>
          )}
          <button onClick={() => setExpanded(e => !e)} className="text-[12px] text-[#888] hover:text-[#333] px-1">
            {expanded ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {s.error && <div className="mt-3 text-[12.5px] text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">{s.error}</div>}

      {expanded && (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Transcript */}
          <div>
            <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">
              Conversation ({s.turns.length} turns)
            </div>
            {s.turns.length === 0 ? (
              <div className="text-[12.5px] text-[#ADADAD] italic">No messages yet…</div>
            ) : (
              <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
                {s.turns.map((t, i) => (
                  <div key={i} className={`flex ${t.role === "patient" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] px-3 py-2 rounded-xl text-[13px] leading-snug ${
                      t.role === "patient"
                        ? "bg-brand-500 text-white rounded-br-sm"
                        : "bg-[#F4F4F2] text-[#222] rounded-bl-sm"
                    }`}>
                      <div className="text-[10px] opacity-70 mb-0.5">
                        {t.role === "patient" ? "Patient (sim)" : "AI Agent"} · {t.channel}
                      </div>
                      {t.message}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Event timeline */}
          <div>
            <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">Timeline</div>
            <div className="space-y-1.5 max-h-[320px] overflow-auto pr-1">
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

export function RealPhone() {
  const qc = useQueryClient();
  const [trigger, setTrigger] = useState<string>("incomplete_call");
  const [scenario, setScenario] = useState("new-patient-cleaning");
  const [env, setEnv] = useState("beta");
  const [practiceOverride, setPracticeOverride] = useState("");
  const [launchMsg, setLaunchMsg] = useState("");

  const { data: cfg } = useQuery({ queryKey: ["realConfig"], queryFn: fetchRealConfig, refetchInterval: 30_000 });
  const { data: sess } = useQuery({
    queryKey: ["realSessions"],
    queryFn: fetchRealSessions,
    refetchInterval: 2_500,
  });
  const { data: suites } = useQuery({
    queryKey: ["realSuites"],
    queryFn: fetchRealSuites,
    refetchInterval: 5_000,
  });

  const suite = useMutation({
    mutationFn: () =>
      runRealSuite({
        trigger_type: trigger,
        env,
        practice_number: practiceOverride || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["realSuites"] });
      setLaunchMsg("✅ Suite started — all 8 scenarios will run sequentially over real phone");
      setTimeout(() => setLaunchMsg(""), 8000);
    },
    onError: (e: Error) => setLaunchMsg(`❌ ${e.message}`),
  });
  const activeSuite = suites?.suites?.find(s => s.status === "running");

  const launch = useMutation({
    mutationFn: () =>
      triggerReal({
        trigger_type: trigger,
        env,
        scenario_id: scenario,
        practice_number: practiceOverride || undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["realSessions"] });
      setLaunchMsg(
        r.cooldown_warning_s > 0
          ? `⚠️ Launched, but this number is in 24h cooldown for another ${fmtCooldown(r.cooldown_warning_s)} — the AI may not reply.`
          : "✅ Launched"
      );
      setTimeout(() => setLaunchMsg(""), 8000);
    },
    onError: (e: Error) => setLaunchMsg(`❌ ${e.message}`),
  });

  const setup = useMutation({
    mutationFn: setupRealWebhooks,
    onSuccess: (r) => setLaunchMsg(`✅ Webhooks configured for ${r.configured.length} number(s)`),
    onError: (e: Error) => setLaunchMsg(`❌ ${e.message}`),
  });

  const practiceDefault = cfg?.practice_numbers?.[env] ?? "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-[19px] font-extrabold text-[#111]">📱 Real Phone Testing</h2>
        <p className="text-[13px] text-[#888] mt-1">
          Real calls and SMS from a dedicated test number to the practice line — the full patient path,
          including ADIT app registration. Unlike API simulations, these conversations appear in the ADIT app.
        </p>
      </div>

      {/* Not configured banner */}
      {cfg && !cfg.configured && (
        <div className="bg-[#FFF7E6] border border-[#F5D998] rounded-2xl p-5">
          <div className="text-[14px] font-bold text-[#92600A]">Twilio not configured yet</div>
          <div className="text-[13px] text-[#92600A] mt-1">
            Set <code className="font-mono bg-white/60 px-1 rounded">TWILIO_ACCOUNT_SID</code>,{" "}
            <code className="font-mono bg-white/60 px-1 rounded">TWILIO_AUTH_TOKEN</code> and{" "}
            <code className="font-mono bg-white/60 px-1 rounded">TWILIO_NUMBERS</code> in Railway, then
            click "Configure webhooks" below once.
          </div>
        </div>
      )}

      {/* Trigger picker */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {TRIGGERS.map(t => (
          <button
            key={t.id}
            onClick={() => setTrigger(t.id)}
            className={`text-left p-4 rounded-2xl border-2 transition-all ${
              trigger === t.id
                ? "border-brand-500 bg-white shadow-md"
                : "border-[#EAEAEA] bg-white hover:border-[#D5D5D5]"
            }`}
          >
            <div className="text-2xl mb-2">{t.icon}</div>
            <div className="text-[13.5px] font-bold text-[#111]">{t.label}</div>
            <div className="text-[11.5px] text-[#888] mt-1 leading-snug">{t.desc}</div>
          </button>
        ))}
      </div>

      {/* Launch controls */}
      <div className="bg-white border border-[#EAEAEA] rounded-2xl p-5 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-1.5">Scenario</label>
          <select
            value={scenario}
            onChange={e => setScenario(e.target.value)}
            className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] bg-white min-w-[230px]"
          >
            {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-1.5">Environment</label>
          <select
            value={env}
            onChange={e => setEnv(e.target.value)}
            className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] bg-white"
          >
            <option value="beta">BETA</option>
            <option value="prod">PROD</option>
          </select>
        </div>
        <div>
          <label className="block text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-1.5">
            Practice number
          </label>
          <input
            value={practiceOverride}
            onChange={e => setPracticeOverride(e.target.value)}
            placeholder={practiceDefault || "+1…"}
            className="border border-[#EAEAEA] rounded-lg px-3 py-2 text-[13px] font-mono w-[170px]"
          />
        </div>
        <button
          onClick={() => launch.mutate()}
          disabled={launch.isPending || !cfg?.configured}
          className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13.5px] px-6 py-2.5 rounded-xl shadow-sm transition-colors"
        >
          {launch.isPending ? "Launching…" : "🚀 Launch"}
        </button>
        <button
          onClick={() => suite.mutate()}
          disabled={suite.isPending || !!activeSuite || !cfg?.configured}
          className="bg-white border-2 border-brand-500 text-brand-600 hover:bg-brand-50 disabled:opacity-40 font-bold text-[13.5px] px-5 py-2 rounded-xl transition-colors"
          title="Run all 8 scenarios sequentially over the real phone path with the selected trigger"
        >
          {activeSuite ? `Suite running (${(activeSuite.current_idx ?? 0) + 1}/${activeSuite.total ?? activeSuite.scenario_ids.length})…` : "🧪 Run Full Suite"}
        </button>
        <button
          onClick={() => setup.mutate()}
          disabled={setup.isPending || !cfg?.configured}
          className="text-[12.5px] text-[#888] hover:text-[#333] underline disabled:opacity-40"
          title="Point your Twilio numbers' SMS webhooks at this platform (run once after adding numbers)"
        >
          Configure webhooks
        </button>
        {launchMsg && <div className="text-[12.5px] font-medium text-[#555] w-full">{launchMsg}</div>}
      </div>

      {/* Suite summaries */}
      {(suites?.suites?.length ?? 0) > 0 && (
        <div className="space-y-2">
          {suites!.suites.map(su => (
            <div key={su.suite_id} className="bg-white border border-[#EAEAEA] rounded-xl px-4 py-2.5 flex items-center gap-4 text-[12.5px]">
              <span className="font-bold text-[#333]">🧪 Suite {su.suite_id}</span>
              <span className="text-[#888]">{su.env.toUpperCase()} · {su.trigger_type.replace(/_/g, " ")}</span>
              {su.status === "running" ? (
                <span className="text-[#1456A0] font-semibold">
                  <span className="inline-block w-[6px] h-[6px] bg-current rounded-full mr-1.5 animate-pulse" />
                  scenario {(su.current_idx ?? 0) + 1} of {su.total ?? su.scenario_ids.length}
                </span>
              ) : (
                <span className="font-semibold">
                  <span className="text-[#166534]">{su.passed ?? 0} passed</span>
                  {" · "}
                  <span className="text-[#991B1B]">{su.failed ?? 0} failed</span>
                  {" · "}
                  <span className="text-[#888]">{su.total ?? su.scenario_ids.length} total</span>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Patient numbers / cooldowns */}
      {cfg?.configured && (
        <div className="flex flex-wrap gap-2">
          {cfg.patient_numbers.map(p => (
            <div key={p.number} className="bg-white border border-[#EAEAEA] rounded-full px-3.5 py-1.5 text-[12px]">
              <span className="font-mono font-semibold text-[#333]">{p.number}</span>
              {Object.entries(p.cooldowns).map(([e, s]) => (
                <span key={e} className={`ml-2 ${s > 0 ? "text-[#92600A]" : "text-[#166534]"}`}>
                  {e}: {fmtCooldown(s)}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Sessions */}
      <div className="space-y-3">
        <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide">
          Sessions {sess?.sessions?.length ? `(${sess.sessions.length})` : ""}
        </div>
        {!sess?.sessions?.length && (
          <div className="text-[13px] text-[#ADADAD] italic bg-white border border-dashed border-[#EAEAEA] rounded-2xl p-8 text-center">
            No real-phone sessions yet — pick a trigger above and launch one.
          </div>
        )}
        {sess?.sessions?.map(s => <SessionCard key={s.session_id} s={s} />)}
      </div>
    </div>
  );
}
