import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import clsx from "clsx";
import type { SimResult } from "../types";

const OUTCOME_META: Record<string, { icon: string; label: string; color: string; bg: string; border: string }> = {
  booking_confirmed: { icon: "📅", label: "Booking Confirmed", color: "#059669", bg: "#F0FDF4", border: "#BBF7D0" },
  task_created:      { icon: "📋", label: "Task Created",      color: "#C2540A", bg: "#FFF7ED", border: "#FED7AA" },
  incomplete:        { icon: "⏳", label: "Incomplete",         color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
  error:             { icon: "🚨", label: "Error",              color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
};

function scoreColor(s: number) {
  if (s >= 80) return "#F5820D";
  if (s >= 60) return "#B45309";
  return "#DC2626";
}

interface Props {
  result: SimResult;
  defaultExpanded?: boolean;
}

export function SimResultCard({ result: r, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const meta = OUTCOME_META[r.outcome_type] ?? { icon: "", label: "", color: "#888", bg: "#FAFAF8", border: "#EAEAEA" };
  const nTurns = Math.floor(r.turns.length / 2);
  const statusIcon = r.passed ? "✅" : "❌";

  const outcomeDetail: Record<string, string> = {
    booking_confirmed: "Direct appointment booking confirmed by agent",
    task_created: "Agent collected info and created a task — team will follow up",
    error: r.failure_reason_clean || r.failure_reason,
    incomplete: r.failure_reason_clean || r.failure_reason || "Conversation did not reach a conclusion",
  };

  return (
    <div className="bg-white border border-[#EAEAEA] rounded-xl mb-3 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      {/* Header (always visible) */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-[#FAFAF8] transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[15px]">{statusIcon}</span>
          <span className="text-[13.5px] font-semibold text-[#111] truncate">{r.scenario_label}</span>
          <span className="text-[12px] text-[#ADADAD] hidden sm:block">·</span>
          <span className="text-[12px] text-[#ADADAD] hidden sm:block">{meta.icon} {meta.label}</span>
          <span className="text-[12px] text-[#ADADAD] hidden sm:block">·</span>
          <span className="text-[12px] font-semibold hidden sm:block" style={{ color: scoreColor(r.score) }}>{r.score}/100</span>
          <span className="text-[12px] text-[#ADADAD] hidden sm:block">· {(r.total_ms / 1000).toFixed(1)}s · {nTurns} turns</span>
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-[#ADADAD] flex-shrink-0" />
          : <ChevronDown className="w-4 h-4 text-[#ADADAD] flex-shrink-0" />
        }
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-[#F0F0EE]">
          {/* Outcome banner */}
          <div
            className="flex items-center gap-3 rounded-lg px-4 py-3 mt-4 mb-4"
            style={{ background: meta.bg, border: `1px solid ${meta.border}` }}
          >
            <span className="text-[18px] flex-shrink-0">{meta.icon}</span>
            <div className="flex-1 min-w-0">
              <span className="font-bold text-[13.5px]" style={{ color: meta.color }}>{meta.label}</span>
              <span className="text-[12.5px] text-[#888] ml-2">
                {outcomeDetail[r.outcome_type] ?? ""}
              </span>
            </div>
            <div
              className="bg-white rounded-md px-3.5 py-1.5 text-center flex-shrink-0"
              style={{ border: `1px solid ${meta.border}` }}
            >
              <div className="text-[9.5px] font-bold uppercase tracking-widest text-[#ADADAD]">Score</div>
              <div className="text-[22px] font-extrabold leading-tight" style={{ color: scoreColor(r.score) }}>
                {r.score}
              </div>
            </div>
          </div>

          {/* Transcript */}
          {r.turns.length === 0 ? (
            <p className="text-[13px] text-[#ADADAD] py-3">No conversation turns recorded.</p>
          ) : (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-3">
                Conversation Transcript
              </div>
              <div className="space-y-2.5">
                {r.turns.map((t, i) =>
                  t.role === "patient" ? (
                    <div key={i} className="flex items-start gap-2.5">
                      <div className="w-7 h-7 bg-[#F0F0EE] rounded-full flex items-center justify-center text-[13px] flex-shrink-0 mt-0.5">
                        👤
                      </div>
                      <div>
                        <div className="text-[10px] font-bold text-[#ADADAD] uppercase tracking-widest mb-1">Patient</div>
                        <div className="patient-bubble">{t.message}</div>
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex items-start gap-2.5 flex-row-reverse">
                      <div className="w-7 h-7 bg-[#FFF3E8] rounded-full flex items-center justify-center text-[13px] flex-shrink-0 mt-0.5">
                        🤖
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-bold text-[#D4620A] uppercase tracking-widest mb-1">
                          Siriyaa {t.latency_ms ? <span className="text-[#ADADAD] normal-case font-normal">· {t.latency_ms.toLocaleString()}ms</span> : null}
                        </div>
                        <div className="agent-bubble">{t.message}</div>
                      </div>
                    </div>
                  )
                )}
              </div>
            </>
          )}

          {/* API calls */}
          {r.api_calls && r.api_calls.length > 0 && (
            <details className="mt-4 border border-[#F0F0EE] rounded-lg overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-[#ADADAD] hover:bg-[#FAFAF8] select-none flex items-center gap-1.5">
                <span className="text-brand-500">⚡</span>
                {r.api_calls.length} API call{r.api_calls.length !== 1 ? "s" : ""}
              </summary>
              <div className="px-3 pb-2 space-y-1">
                {r.api_calls.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className={clsx("font-bold w-8 text-right flex-shrink-0",
                      c.status === 200 ? "text-green-600" : "text-red-500"
                    )}>{c.status}</span>
                    <span className="font-mono text-[#555] truncate">{c.endpoint}</span>
                    {c.latency_ms > 0 && <span className="text-[#ADADAD] ml-auto flex-shrink-0">{c.latency_ms}ms</span>}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Footer */}
          <div className="mt-4 pt-3 border-t border-[#F0F0EE]">
            {r.failure_reason && r.passed && (
              <p className="text-[12px] text-[#888] mb-1">
                <strong>Judge note:</strong> {r.failure_reason_clean || r.failure_reason}
              </p>
            )}
            <p className="text-[11px] text-[#ADADAD]">
              📞 {r.patient_phone} &nbsp;·&nbsp; 🔗{" "}
              <code className="bg-[#F5F5F3] px-1 py-0.5 rounded text-[10.5px]">
                {r.chat_id ? r.chat_id.slice(0, 32) : "—"}
              </code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
