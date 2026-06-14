/**
 * RealManualConsole — a human drives the patient side over REAL SMS.
 * Start with a text or a call trigger; type each message; the AI agent
 * replies for real and everything registers in the ADIT app.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRealSessions, manualStart, manualSend, manualEnd } from "../api";
import { STATUS_STYLES, STATUS_LABEL, fmtPhone } from "./RealSessionCard";

export function RealManualConsole({ env, practiceNumber }: { env: string; practiceNumber?: string }) {
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
        practice_number: practiceNumber,
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
