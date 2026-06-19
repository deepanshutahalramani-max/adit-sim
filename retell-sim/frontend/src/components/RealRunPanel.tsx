/**
 * RealRunPanel — the ONE shared way every page runs tests over the real phone path.
 *
 * Used by Simulations (SMS + Call), Debug Suite (repro validation), and E2E Chain
 * (Patient Journey). Launches a real-phone suite, then renders live progress and
 * session cards by polling the suite + sessions endpoints.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PhoneMissed, PhoneOff, MessageSquare, Mic, Phone, Play, SlidersHorizontal, ChevronDown } from "lucide-react";
import { runRealSuite, fetchRealSuites, fetchRealSessions, fetchRealConfig } from "../api";
import { RealSessionCard, REAL_TRIGGERS } from "./RealSessionCard";

const TRIGGER_ICON: Record<string, typeof Phone> = {
  missed_call: PhoneMissed,
  incomplete_call: PhoneOff,
  inbound_sms: MessageSquare,
  inbound_call: Mic,
};

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
  const [launchedIds, setLaunchedIds] = useState<string[]>([]);  // every run started from this panel
  const [msg, setMsg] = useState("");
  const [runs, setRuns] = useState(1);          // runs per scenario (suite kind)
  const [concurrency, setConcurrency] = useState(0);  // 0 = auto (= effective max)
  const [showOpts, setShowOpts] = useState(false);

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
    refetchInterval: launchedIds.length ? 4000 : 10000,
  });
  const { data: sess } = useQuery({
    queryKey: ["realSessions"], queryFn: fetchRealSessions,
    refetchInterval: launchedIds.length ? 3000 : 10000,
  });

  // Every run launched from this panel stays visible — launching another never
  // hides the previous one (it keeps running and remains on screen).
  const myRuns = (suites?.suites ?? []).filter(s => launchedIds.includes(s.suite_id));
  const mySessions = (sess?.sessions ?? [])
    .filter(s => launchedIds.includes(s.suite_id))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const anyMineRunning = myRuns.some(s => s.status === "running");

  // How many patient numbers are FREE right now — you can launch more runs as long
  // as at least one is free (the backend queues the rest as numbers free up).
  const freeNow = isProdSms
    ? ((cfg?.patient_numbers ?? []).filter(p => p.provider === "ringcentral").every(p => !p.busy) ? 1 : 0)
    : (cfg?.patient_numbers ?? []).filter(p => p.provider === "twilio" && !p.busy).length;
  const noneFree = (cfg?.patient_numbers?.length ?? 0) > 0 && freeNow === 0;

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
      setLaunchedIds(prev => prev.includes(r.suite_id) ? prev : [r.suite_id, ...prev]);
      qc.invalidateQueries({ queryKey: ["realSuites"] });
      setMsg("");
    },
    onError: (e: Error) => setMsg(e.message),
  });

  const totalScenarios = kind === "journey" ? 3 : kind === "repro" ? (repeat ?? 1) : scenarioCount * runsClamped;
  const queued = Math.max(0, totalScenarios - effectiveMax);

  return (
    <div className="space-y-5">
      {/* Trigger picker — segmented control */}
      {triggers.length > 1 && (
        <div>
          <div className="section-label mb-2">Conversation entry point</div>
          <div className="inline-flex flex-wrap gap-1 p-1 bg-canvas-sunken rounded-xl border border-line">
            {triggers.map(t => {
              const Icon = TRIGGER_ICON[t.id] ?? Phone;
              const on = trigger === t.id;
              return (
                <button key={t.id} onClick={() => setTrigger(t.id)} title={t.desc}
                  className={`inline-flex items-center gap-2 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors ${
                    on ? "bg-canvas-raised text-ink-900 shadow-card" : "text-ink-400 hover:text-ink-700"
                  }`}>
                  <Icon className="w-4 h-4" strokeWidth={2} /> {t.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Advanced options — collapsed by default (progressive disclosure) */}
      {kind === "suite" && (
        <div>
          <button onClick={() => setShowOpts(o => !o)}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-500 hover:text-ink-900 transition-colors">
            <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={2} />
            Options
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showOpts ? "rotate-180" : ""}`} strokeWidth={2} />
            <span className="font-normal text-ink-400">
              · {totalScenarios} run{totalScenarios === 1 ? "" : "s"}, up to {effectiveMax} at once
            </span>
          </button>
          {showOpts && (
            <div className="mt-3 card p-4 flex items-end gap-5 flex-wrap">
              <label className="flex flex-col gap-1.5">
                <span className="section-label">Runs per scenario</span>
                <input type="number" min={1} max={maxRuns} value={runsClamped}
                  onChange={e => setRuns(Math.min(Math.max(1, parseInt(e.target.value) || 1), maxRuns))}
                  className="field !w-24 !py-2" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="section-label">Run concurrently</span>
                <input type="number" min={1} max={effectiveMax} value={concDisplay}
                  onChange={e => setConcurrency(Math.min(Math.max(1, parseInt(e.target.value) || 1), effectiveMax))}
                  className="field !w-24 !py-2" />
              </label>
              <p className="text-[12px] text-ink-500 leading-relaxed flex-1 min-w-[220px]">
                <b className="text-ink-700">{totalScenarios} total run{totalScenarios === 1 ? "" : "s"}.</b>{" "}
                Up to <b>{effectiveMax}</b> at once{isProdSms ? " (PROD SMS uses one number)" : " (limited by patient numbers)"}
                {queued > 0 ? <> — the remaining <b>{queued}</b> queue automatically.</> : "."}
                {" "}<span className="text-ink-400">{freeNow} free now.</span>
              </p>
            </div>
          )}
        </div>
      )}

      {/* Primary action */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => launch.mutate()}
          disabled={disabled || launch.isPending || noneFree || totalScenarios === 0}
          className="btn-primary btn-lg">
          <Play className="w-4 h-4" strokeWidth={2.5} />
          {launch.isPending ? "Launching…"
            : anyMineRunning ? (buttonLabel ?? `Run more (${totalScenarios})`)
            : buttonLabel ?? `Run over real phone (${totalScenarios})`}
        </button>
        <span className="text-[12px] text-ink-400 max-w-sm leading-snug">
          {kind === "journey"
            ? "Journey phases run in sequence on one identity (~5 min each), live below."
            : "Scenarios run in parallel — launch more anytime a number is free."}
        </span>
        {noneFree && (
          <span className="text-[12px] text-[#B45309] w-full">
            All patient numbers are busy — they’ll free up as conversations finish, then you can launch again.
          </span>
        )}
        {disabled && disabledReason && <span className="text-[12px] text-[#B45309] w-full">{disabledReason}</span>}
        {msg && <span className="text-[12.5px] font-medium text-[#B91C1C] w-full">{msg}</span>}
      </div>

      {/* Progress — one row per run launched from this panel (none are ever hidden) */}
      {myRuns.map(run => (
        <div key={run.suite_id} className="card flex items-center gap-4 px-4 py-2.5 text-[12.5px] flex-wrap">
          <span className="font-semibold text-ink-700">
            {run.kind === "journey" ? "Journey" : run.kind === "repro" ? "Repro" : "Suite"}{" "}
            <span className="font-mono text-ink-400">{run.suite_id}</span>
          </span>
          <span className="text-ink-400">{run.env.toUpperCase()} · {run.trigger_type.replace(/_/g, " ")}</span>
          {run.status === "running" ? (
            <span className="inline-flex items-center gap-1.5 text-brand-600 font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              {run.done ?? 0} of {run.total ?? run.scenario_ids?.length ?? 0} done
            </span>
          ) : (
            <span className="font-semibold">
              <span className="text-[#15803D]">{run.passed ?? 0} passed</span>
              <span className="text-ink-300"> · </span>
              <span className="text-[#B91C1C]">{run.failed ?? 0} failed</span>
            </span>
          )}
        </div>
      ))}

      {/* Live session cards across every run from this panel */}
      {mySessions.map(s => <RealSessionCard key={s.session_id} s={s} compact />)}
    </div>
  );
}
