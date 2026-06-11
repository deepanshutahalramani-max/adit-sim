import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { stopRealSession } from "../api";
import type { RealSession } from "../api";

export const REAL_TRIGGERS = [
  { id: "missed_call",     icon: "📵", label: "Missed Call",
    desc: "Call rings, we hang up before answer. AI texts back." },
  { id: "incomplete_call", icon: "📞", label: "Incomplete Call",
    desc: "AI answers, we hang up mid-call. AI texts back." },
  { id: "inbound_sms",     icon: "💬", label: "Inbound SMS",
    desc: "Direct text. Needs no chat in last 24h on the number." },
  { id: "inbound_call",    icon: "🎙️", label: "Voice Call",
    desc: "Full live voice conversation with the AI Front Desk." },
] as const;

export const STATUS_STYLES: Record<string, string> = {
  starting:        "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]",
  calling:         "bg-[#EAF3FF] text-[#1456A0] border-[#B5D4F5]",
  waiting_for_sms: "bg-[#FFF7E6] text-[#92600A] border-[#F5D998]",
  in_conversation: "bg-[#EAF3FF] text-[#1456A0] border-[#B5D4F5]",
  completed:       "bg-[#F2FDF4] text-[#166534] border-[#B8EFC8]",
  failed:          "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]",
};

export const STATUS_LABEL: Record<string, string> = {
  starting: "starting", calling: "📞 calling", waiting_for_sms: "⏳ waiting for AI SMS",
  in_conversation: "💬 conversing", completed: "✓ completed", failed: "✗ failed",
};

export function fmtPhone(n: string): string {
  const d = n.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n;
}

export function RealSessionCard({ s, compact }: { s: RealSession; compact?: boolean }) {
  const [expanded, setExpanded] = useState(!compact);
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => stopRealSession(s.session_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["realSessions"] }),
  });
  const trig = REAL_TRIGGERS.find(t => t.id === s.trigger_type);
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
