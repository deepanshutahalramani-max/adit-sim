/**
 * RealRunPanel — the ONE shared way every page runs tests over the real phone path.
 *
 * Used by Simulations (SMS + Call), Debug Suite (repro validation), and E2E Chain
 * (Patient Journey). Launches a real-phone suite, then renders live progress and
 * session cards by polling the suite + sessions endpoints.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { runRealSuite, fetchRealSuites, fetchRealSessions } from "../api";
import { RealSessionCard, REAL_TRIGGERS } from "./RealSessionCard";

interface Props {
  env: "beta" | "prod";              // mapped from sidebar environment
  kind: "suite" | "journey" | "repro";
  scenarioIds?: string[];            // suite kind
  opener?: string;                   // repro kind
  goal?: string;                     // repro kind
  label?: string;                    // repro kind
  repeat?: number;                   // repro kind
  buttonLabel?: string;
  /** Triggers selectable for SMS flows; pass ["inbound_call"] for voice. */
  allowedTriggers?: string[];
  disabled?: boolean;
  disabledReason?: string;
}

export function RealRunPanel({
  env, kind, scenarioIds, opener, goal, label, repeat,
  buttonLabel, allowedTriggers, disabled, disabledReason,
}: Props) {
  const qc = useQueryClient();
  const triggers = REAL_TRIGGERS.filter(t => !allowedTriggers || allowedTriggers.includes(t.id));
  const [trigger, setTrigger] = useState<string>(triggers[0]?.id ?? "incomplete_call");
  const [suiteId, setSuiteId] = useState("");
  const [msg, setMsg] = useState("");

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
      trigger_type: trigger,
      scenario_ids: kind === "suite" ? scenarioIds : undefined,
      opener: kind === "repro" ? opener : undefined,
      goal: kind === "repro" ? goal : undefined,
      label: kind === "repro" ? label : undefined,
      repeat: kind === "repro" ? repeat : undefined,
    }),
    onSuccess: r => {
      setSuiteId(r.suite_id);
      qc.invalidateQueries({ queryKey: ["realSuites"] });
      setMsg("");
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const totalScenarios = kind === "journey" ? 3 : kind === "repro" ? (repeat ?? 1) : (scenarioIds?.length ?? 0);

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

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => launch.mutate()}
          disabled={disabled || launch.isPending || anyRunning || totalScenarios === 0}
          className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white font-bold text-[13.5px] px-6 py-2.5 rounded-xl shadow-sm"
        >
          {anyRunning && !mySuite ? "Another run in progress…"
            : mySuite?.status === "running" ? `Running ${(mySuite.current_idx ?? 0) + 1}/${mySuite.total ?? totalScenarios}…`
            : buttonLabel ?? `📱 Run over Real Phone (${totalScenarios})`}
        </button>
        <span className="text-[11.5px] text-[#888]">
          Real calls/SMS take a few minutes each — runs are sequential and appear live below.
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
              scenario {(mySuite.current_idx ?? 0) + 1} of {mySuite.total ?? totalScenarios}
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
