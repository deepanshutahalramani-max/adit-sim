import { useState } from "react";
import { Play } from "lucide-react";
import { runChain } from "../api";
import type { Config, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";

interface Props {
  config: Config;
  onResults: (rs: Record<string, SimResult>) => void;
  chainResults: Record<string, SimResult> | null;
}

const PHASES = [
  { id: "new-patient-cleaning", label: "Phase 1 — Book",      icon: "🆕", color: "#2563EB" },
  { id: "reschedule",           label: "Phase 2 — Reschedule", icon: "🔄", color: "#10B981" },
  { id: "cancel",               label: "Phase 3 — Cancel",     icon: "❌", color: "#EF4444" },
] as const;

export function E2EChain({ config, onResults, chainResults }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const handleRun = async () => {
    if (!config.bearerToken) { setError("Bearer token required in sidebar."); return; }
    if (!config.openaiKey)   { setError("OpenAI key required for smart patient responses."); return; }
    setError("");
    setRunning(true);
    try {
      const res = await runChain({
        api_base: config.apiBase,
        bearer_token: config.bearerToken,
        agent_phone: config.agentPhone,
        openai_key: config.openaiKey,
      });
      onResults(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Chain run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Full E2E Chain</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Book → Reschedule → Cancel on one phone number. Each phase looks up the appointment
          from the previous — exercises the full API chain end-to-end.
        </p>
      </div>

      {/* Info cards */}
      <div className="flex gap-4 mb-6 flex-wrap">
        <div className="flex-1 min-w-[220px] bg-white border border-[#E2E8F0] border-t-[3px] border-t-[#2563EB] rounded-xl p-5">
          <div className="text-[11px] font-bold uppercase tracking-widest text-[#94A3B8] mb-3">Three Phases</div>
          <div className="space-y-1.5">
            {PHASES.map(p => (
              <div key={p.id} className="text-[13.5px] text-[#444]">
                <span className="mr-2">{p.icon}</span>{p.label.replace(/Phase \d — /, "")}
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-[220px] bg-white border border-[#E2E8F0] border-t-[3px] border-t-[#10B981] rounded-xl p-5">
          <div className="text-[11px] font-bold uppercase tracking-widest text-[#94A3B8] mb-3">API Chain Covered</div>
          <div className="space-y-1.5 text-[13.5px] text-[#444]">
            {["Create New Patient", "Get Available Slots", "Book / Modify / Cancel Appointment", "Upcoming Appointment lookup", "Task Creation"].map(s => (
              <div key={s}>· {s}</div>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
          {error}
        </div>
      )}

      <button
        onClick={handleRun}
        disabled={running}
        className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-8 shadow-sm"
      >
        <Play className="w-4 h-4" />
        {running ? "Running Book → Reschedule → Cancel…" : "Run Full Chain"}
      </button>

      {chainResults && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            {PHASES.map(p => {
              const r = chainResults[p.id];
              if (!r) return null;
              return (
                <div key={p.id} className="bg-white border border-[#EAEAEA] rounded-xl p-4">
                  <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">
                    {p.icon} {p.label}
                  </div>
                  <div className="text-[16px] font-bold text-[#111]">
                    {r.passed ? "✅ Passed" : "❌ Failed"}
                  </div>
                  <div className="text-[12px] text-[#ADADAD] mt-0.5">
                    {r.score}/100 · {(r.total_ms / 1000).toFixed(1)}s
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-[#EAEAEA] pt-6 space-y-6">
            {PHASES.map(p => {
              const r = chainResults[p.id];
              if (!r) return null;
              return (
                <div key={p.id}>
                  <div className="text-[13px] font-bold text-[#333] mb-2">{p.icon} {p.label}</div>
                  <SimResultCard result={r} defaultExpanded />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
