import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { stopRealSession, reanalyzeFeedback } from "../api";
import type { RealSession } from "../api";

/** Deep-link to this session's Retell record: voice → call-history, SMS/chat → chat-history. */
function retellUrl(s: RealSession): string {
  const kind = s.trigger_type === "inbound_call" ? "call" : "chat";
  return `https://dashboard.retellai.com/${kind}-history?history=${s.retell_id}`;
}

/* ── Self-improving feedback: comment → LLM re-analysis (shared endpoint) ─────── */
function FeedbackBox({ s }: { s: RealSession }) {
  const [comment, setComment] = useState("");
  const [results, setResults] = useState<{ comment: string; refined: string; author: string }[]>([]);
  const send = useMutation({
    mutationFn: () => reanalyzeFeedback({ session_id: s.session_id, comment }),
    onSuccess: r => { setResults(prev => [...prev, { comment, refined: r.refined_analysis, author: r.author }]); setComment(""); },
  });
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="section-label mb-2">💬 Reviewer feedback → AI re-analysis</div>
      {results.map((c, i) => (
        <div key={i} className="mb-2 text-[12px]">
          <div className="bg-canvas-sunken rounded-lg px-3 py-1.5"><b className="text-ink-700">{c.author}:</b> {c.comment}</div>
          {c.refined && (
            <div className="mt-1 bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg px-3 py-2 text-[#5B21B6] leading-snug">
              <b>Refined analysis:</b> {c.refined}
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-2 mt-1">
        <input value={comment} onChange={e => setComment(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && comment.trim()) send.mutate(); }}
          placeholder="Add a comment — the platform re-reads it with the transcript (e.g. 'service mismatch, fix the prompt')"
          className="field !py-2 flex-1 text-[12.5px]" />
        <button onClick={() => send.mutate()} disabled={!comment.trim() || send.isPending}
          className="btn-primary btn-sm whitespace-nowrap">
          {send.isPending ? "Analyzing…" : "Re-analyze"}
        </button>
      </div>
    </div>
  );
}

/* ── Live call audio (Twilio media stream relayed over WebSocket) ──────────── */

function ulawToFloat(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 7;
  const man = u & 0x0f;
  let x = ((man << 3) + 0x84) << exp;
  x -= 0x84;
  return (sign ? -x : x) / 32768;
}

function LiveListen({ sessionId }: { sessionId: string }) {
  const [listening, setListening] = useState(false);
  const ref = useRef<{ ctx: AudioContext; ws: WebSocket; t: Record<string, number> } | null>(null);

  const stop = () => {
    try { ref.current?.ws.close(); } catch { /* noop */ }
    try { ref.current?.ctx.close(); } catch { /* noop */ }
    ref.current = null;
    setListening(false);
  };

  const start = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/real/listen/${sessionId}`);
    const ctx = new AudioContext({ sampleRate: 8000 });
    const t: Record<string, number> = { inbound: 0, outbound: 0 };
    ws.onmessage = e => {
      try {
        const { track, payload } = JSON.parse(e.data);
        const bin = atob(payload);
        const n = bin.length;
        if (n === 0) return;
        const buf = ctx.createBuffer(1, n, 8000);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = ulawToFloat(bin.charCodeAt(i));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const key = track === "outbound" ? "outbound" : "inbound";
        const at = Math.max(ctx.currentTime + 0.05, t[key]);
        src.start(at);
        t[key] = at + buf.duration;
      } catch { /* skip bad frame */ }
    };
    ws.onclose = () => { if (ref.current?.ws === ws) stop(); };
    ref.current = { ctx, ws, t };
    setListening(true);
  };

  return (
    <button
      onClick={() => (listening ? stop() : start())}
      className={`text-[11.5px] font-bold px-3 py-1 rounded-full border transition-colors ${
        listening
          ? "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA] animate-pulse"
          : "bg-[#1A1A1A] text-white border-[#1A1A1A] hover:bg-[#333]"
      }`}
      title="Hear the call audio live while the conversation is happening"
    >
      {listening ? "⏹ Stop listening" : "🔴 Listen LIVE"}
    </button>
  );
}

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
  const isActive = !["completed", "failed"].includes(s.status);
  // Live sessions always start expanded so the conversation is visible in real time
  const [expanded, setExpanded] = useState(!compact || isActive);
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => stopRealSession(s.session_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["realSessions"] }),
  });
  const trig = REAL_TRIGGERS.find(t => t.id === s.trigger_type);
  const active = isActive;

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
          {active && s.trigger_type === "inbound_call" && (
            <LiveListen sessionId={s.session_id} />
          )}
          {active && (
            <button onClick={() => stop.mutate()}
              className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-[#FECACA] bg-[#FEF2F2] text-[#991B1B] hover:bg-[#FEE2E2]">
              Stop
            </button>
          )}
          {s.retell_id && (
            <a href={retellUrl(s)} target="_blank" rel="noopener noreferrer"
              title="Open this conversation in the Retell dashboard"
              className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full border border-[#C7D2FE] bg-[#EEF2FF] text-[#3730A3] hover:bg-[#E0E7FF]">
              View in Retell ↗
            </a>
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
      {s.triage && (
        <div className="mt-2 text-[12px] text-[#92600A] bg-[#FFF7ED] border border-[#FED7AA] rounded-lg px-3 py-2">
          <span className="font-bold">Why it failed:</span> {s.triage}
        </div>
      )}
      {(s.issues?.length ?? 0) > 0 && (
        <div className="mt-2 space-y-1.5">
          {s.issues!.map((iss, i) => (
            <div key={i} className="text-[12px] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
              <span className="font-bold text-[#991B1B]">⚠ {iss.title}</span>
              <div className="text-[#7C2D12] mt-0.5 leading-snug">{iss.detail}</div>
            </div>
          ))}
        </div>
      )}

      {s.recording_url && (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[12px] font-semibold text-[#555]">🔊 Call recording ({s.recording_duration_s}s)</span>
          <audio controls preload="none" src={s.recording_url} className="h-9 flex-1 max-w-[420px]" />
        </div>
      )}

      {/* Auto-diagnosed root-cause findings */}
      {(s.issues?.length ?? 0) > 0 && (
        <div className="mt-3 space-y-2">
          {s.issues!.map((iss, i) => (
            <div key={i} className={`rounded-xl border px-3.5 py-2.5 ${
              iss.severity === "high" ? "border-[#FECACA] bg-[#FEF2F2]" : "border-[#FED7AA] bg-[#FFF7ED]"
            }`}>
              <div className="flex items-center gap-2">
                <span className="text-[13px]">🔎</span>
                <span className={`text-[12.5px] font-bold ${iss.severity === "high" ? "text-[#B91C1C]" : "text-[#B45309]"}`}>
                  {iss.title}
                </span>
                <span className={`pill !py-0 !text-[10px] ${iss.severity === "high" ? "pill-bad" : "pill-warn"}`}>{iss.severity}</span>
              </div>
              <div className="text-[11.5px] text-ink-500 mt-1 leading-snug pl-5">{iss.detail}</div>
            </div>
          ))}
        </div>
      )}

      {/* EHR / agent API calls — the booking-flow functions, with timing + failures */}
      {expanded && (s.ehr_calls?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="text-[11.5px] font-bold text-[#ADADAD] uppercase tracking-wide mb-2">
            EHR API calls ({s.ehr_calls!.length}) — agent → ADIT
          </div>
          <div className="space-y-1.5">
            {s.ehr_calls!.map((c, i) => (
              <div key={i} className={`rounded-lg border px-3 py-2 ${
                c.business_ok ? "border-line bg-canvas-raised" : "border-[#FECACA] bg-[#FEF2F2]"
              }`}>
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.business_ok ? "bg-[#22C55E]" : "bg-[#EF4444]"}`} />
                  <span className="font-mono font-semibold text-ink-700">{c.name}</span>
                  <span className={`text-[11px] font-bold ${c.business_ok ? "text-[#15803D]" : "text-[#B91C1C]"}`}>
                    {c.business_ok ? "success" : "FAILED"}
                  </span>
                  <span className="ml-auto text-[11px] text-ink-400 font-medium" title={c.latency_ms > 0 ? "Time between Retell's tool-call invocation and result" : "Per-call timing not reported by Retell for this turn"}>
                    ⏱ {c.latency_ms > 0 ? `${c.latency_ms}ms` : "—"}
                  </span>
                </div>
                {!c.business_ok && c.result && (
                  <div className="text-[11px] text-[#B91C1C] mt-1 pl-3.5 leading-snug">{c.result}</div>
                )}
              </div>
            ))}
          </div>
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

      {expanded && !active && <FeedbackBox s={s} />}
    </div>
  );
}
