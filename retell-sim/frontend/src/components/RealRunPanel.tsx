/**
 * RealRunPanel — the ONE shared way every page runs tests over the real phone path.
 *
 * Used by Simulations (SMS + Call), Debug Suite (repro validation), and E2E Chain
 * (Patient Journey). Launches a real-phone suite, then renders live progress and
 * session cards by polling the suite + sessions endpoints.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { runRealSuite, fetchRealSuites, fetchRealSessions, fetchRealConfig } from "../api";
import { RealSessionCard, REAL_TRIGGERS } from "./RealSessionCard";

interface Props {
  env: string;                       // "beta" | "prod" | "custom"
  practiceNumber?: string;           // required for custom env — the number to call/text
  kind: "suite" | "journey" | "repro";
  scenarioIds?: string[];            // suite kind
  opener?: string;                   // repro kind
  goal?: string;                     // repro kind
  label?: string;                    // repro kind
  repeat?: number;                   // repro kind
  extraContext?: string;             // reviewer-supplied scenario context for the AI patient
  buttonLabel?: string;
  /** Triggers selectable for SMS flows; pass ["inbound_call"] for voice. */
  allowedTriggers?: string[];
  disabled?: boolean;
  disabledReason?: string;
}

export function RealRunPanel({
  env, practiceNumber, kind, scenarioIds, opener, goal, label, repeat, extraContext,
  buttonLabel, allowedTriggers, disabled, disabledReason,
}: Props) {
  const qc = useQueryClient();
  const triggers = REAL_TRIGGERS.filter(t => !allowedTriggers || allowedTriggers.includes(t.id));
  const [trigger, setTrigger] = useState<string>(triggers[0]?.id ?? "incomplete_call");
  const [suiteId, setSuiteId] = useState("");
  const [msg, setMsg] = useState("");
  const [runs, setRuns] = useState(1);          // runs per scenario (suite kind)
  const [concurrency, setConcurrency] = useState(0);  // 0 = auto (= effective max)

  const { data: cfg } = useQuery({ queryKey: ["realConfig"], queryFn: fetchRealConfig, refetchInterval: 30_000 });

  // Effective simultaneous cap = patient-number pool, but PROD SMS is single-number (RingCentral).
  const twilioPool = (cfg?.patient_numbers ?? []).filter(p => p.provider === "twilio").length || 4;
  const isProdSms = env === "prod" && trigger !== "inbound_call";
  const effectiveMax = isProdSms ? 1 : twilioPool;

  const scenarioCount = scenarioIds?.length ?? 0;
  const maxRuns = scenarioCount > 0 ? Math.max(1, Math.floor(20 / scenarioCount)) : 20;
  const runsClamped = Math.min(Math.max(1, runs), maxRuns);
  const concDisplay = concurrency > 0 ? Math.min(concurrency, effectiveMax) : effectiveMax;

  const { data: suites } = useQuery({
    queryKey: ["realSuites"], queryFn: fetchRealSuites,
    refetchInterval: suiteId ? 4000 : 10000,
  });
  const { data: sess } = useQuery({
    queryKey: ["realSessions"], queryFn: fetchRealSessions,
    refetchInterval: suiteId ? 3000 : 10000,
  });

  const mySuite = suites?.suites?.find(s => s.suite_id === suiteId);
  const mySessions = (sess?.sessions ?? []).filter(s => s.suite_id === suiteId);
  const anyRunning = suites?.suites?.some(s => s.status === "running") ?? false;

  const launch = useMutation({
    mutationFn: () => runRealSuite({
      kind,
      env,
      practice_number: practiceNumber,
      trigger_type: trigger,
      scenario_ids: kind === "suite" ? scenarioIds : undefined,
      opener: kind === "repro" ? opener : undefined,
      goal: kind === "repro" ? goal : undefined,
      label: kind === "repro" ? label : undefined,
      repeat: kind === "suite" ? runsClamped : (kind === "repro" ? repeat : undefined),
      concurrency: kind === "suite" ? concDisplay : undefined,
      extra_context: extraContext || undefined,
    }),
    onSuccess: r => {
      setSuiteId(r.suite_id);
      qc.invalidateQueries({ queryKey: ["realSuites"] });
      setMsg("");
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const totalScenarios = kind === "journey" ? 3 : kind === "repro" ? (repeat ?? 1) : scenarioCount * runsClamped;
  const queued = Math.max(0, totalScenarios - effectiveMax);

  return (
    <div className="space-y-4">
      {/* Trigger picker (only when there is a choice) */}
      {triggers.length > 1 && (
        <div>
          <div className="text-[11px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">
            Conversation entry point
          </div>
          <div className="flex gap-2 flex-wrap">
            {triggers.map(t => (
              <button key={t.id} onClick={() => setTrigger(t.id)} title={t.desc}
                className={`text-[12.5px] font-semibold px-3.5 py-2 rounded-xl border-2 transition-all ${
                  trigger === t.id ? "border-brand-500 bg-white shadow-sm text-[#111]" : "border-[#EAEAEA] bg-white text-[#888]"
                }`}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Repeat + concurrency (suite kind only) */}
      {kind === "suite" && (
        <div className="bg-[#FAFAF9] border border-[#EAEAEA] rounded-xl p-3.5">
          <div className="flex items-end gap-5 flex-wrap">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-[#ADADAD] uppercase tracking-wide">Runs per scenario</span>
              <input
                type="number" min={1} max={maxRuns} value={runsClamped}
                onChange={e => setRuns(Math.min(Math.max(1, parseInt(e.target.value) || 1), maxRuns))}
                className="w-24 text-[13px] text-[#111] bg-white border border-[#EAEAEA] rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-[#ADADAD] uppercase tracking-wide">Run concurrently</span>
              <input
                type="number" min={1} max={effectiveMax} value={concDisplay}
                onChange={e => setConcurrency(Math.min(Math.max(1, parseInt(e.target.value) || 1), effectiveMax))}
                className="w-24 text-[13px] text-[#111] bg-white border border-[#EAEAEA] rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500"
              />
            </label>
            <div className="text-[12px] text-[#666] leading-snug flex-1 min-w-[220px]">
              <span className="font-semibold text-[#333]">{totalScenarios} total run{totalScenarios === 1 ? "" : "s"}.</span>{" "}
              Up to <b>{effectiveMax}</b> run at once{isProdSms ? " (PROD SMS uses one number)" : " (limited by patient numbers)"}
              {queued > 0 ? <> — the remaining <b>{queued}</b> queue and start automatically as numbers free up.</> : "."}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => launch.mutate()}
          disabled={disabled || launch.isPending || anyRunning || totalScenarios === 0}
          className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13.5px] px-6 py-2.5 rounded-xl shadow-sm"
        >
          {anyRunning && !mySuite ? "Another run in progress…"
            : mySuite?.status === "running" ? `Running — ${mySuite.done ?? 0}/${mySuite.total ?? totalScenarios} done…`
            : buttonLabel ?? `📱 Run over Real Phone (${totalScenarios})`}
        </button>
        <span className="text-[11.5px] text-[#888]">
          {kind === "journey"
            ? "Journey phases run sequentially on one identity (~5 min each) and appear live below."
            : "Scenarios run in PARALLEL across the patient numbers — watch them all live below."}
        </span>
        {disabled && disabledReason && <span className="text-[11.5px] text-[#92600A] w-full">{disabledReason}</span>}
        {msg && <span className="text-[12.5px] font-medium text-[#991B1B] w-full">{msg}</span>}
      </div>

      {/* Suite progress */}
      {mySuite && (
        <div className="bg-white border border-[#EAEAEA] rounded-xl px-4 py-2.5 flex items-center gap-4 text-[12.5px] flex-wrap">
          <span className="font-bold text-[#333]">
            {mySuite.kind === "journey" ? "🧭 Journey" : mySuite.kind === "repro" ? "🔁 Repro" : "🧪 Suite"} {mySuite.suite_id}
          </span>
          <span className="text-[#888]">{mySuite.env.toUpperCase()} · {mySuite.trigger_type.replace(/_/g, " ")}</span>
          {mySuite.status === "running" ? (
            <span className="text-[#1456A0] font-semibold">
              <span className="inline-block w-[6px] h-[6px] bg-current rounded-full mr-1.5 animate-pulse" />
              {mySuite.done ?? 0} of {mySuite.total ?? totalScenarios} done
            </span>
          ) : (
            <span className="font-semibold">
              <span className="text-[#166534]">{mySuite.passed ?? 0} passed</span>{" · "}
              <span className="text-[#991B1B]">{mySuite.failed ?? 0} failed</span>
            </span>
          )}
        </div>
      )}

      {/* Live session cards for this run */}
      {mySessions.map(s => <RealSessionCard key={s.session_id} s={s} compact />)}
    </div>
  );
}
