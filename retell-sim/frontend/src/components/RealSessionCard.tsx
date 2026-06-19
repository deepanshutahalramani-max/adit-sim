import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PhoneMissed, PhoneOff, MessageSquare, Mic, Phone, ChevronDown, Square,
  ExternalLink, Volume2, Zap, Clock, AlertTriangle, Radio,
} from "lucide-react";
import { stopRealSession, reanalyzeFeedback } from "../api";
import type { RealSession } from "../api";

const TRIGGER_ICON: Record<string, typeof Phone> = {
  missed_call: PhoneMissed,
  incomplete_call: PhoneOff,
  inbound_sms: MessageSquare,
  inbound_call: Mic,
};

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
      <div className="section-label mb-2 inline-flex items-center gap-1.5">
        <MessageSquare className="w-3 h-3" strokeWidth={2} /> Reviewer feedback → AI re-analysis
      </div>
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
      className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1 rounded-full border transition-colors ${
        listening
          ? "bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]"
          : "bg-ink-900 text-white border-ink-900 hover:bg-ink-700"
      }`}
      title="Hear the call audio live while the conversation is happening"
    >
      {listening
        ? <><Square className="w-3 h-3 fill-current" strokeWidth={0} /> Stop</>
        : <><Radio className="w-3.5 h-3.5 animate-pulse" strokeWidth={2} /> Listen live</>}
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
  starting:        "pill-warn",
  calling:         "pill-info",
  waiting_for_sms: "pill-warn",
  in_conversation: "pill-info",
  completed:       "pill-ok",
  failed:          "pill-bad",
};

export const STATUS_LABEL: Record<string, string> = {
  starting: "Starting", calling: "Calling", waiting_for_sms: "Waiting for AI SMS",
  in_conversation: "Conversing", completed: "Completed", failed: "Failed",
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
  const TrigIcon = TRIGGER_ICON[s.trigger_type] ?? Phone;
  const active = isActive;
  const scorePill = s.score >= 80 ? "pill-ok" : s.score >= 60 ? "pill-warn" : "pill-bad";
  const outcomeOk = ["booking_confirmed", "task_created"].includes(s.outcome);

  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex-shrink-0 w-9 h-9 rounded-full bg-canvas-sunken text-ink-500 grid place-items-center">
            <TrigIcon className="w-[18px] h-[18px]" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="text-[14.5px] font-semibold text-ink-900 truncate tracking-[-0.01em]">
              {s.scenario_label || s.scenario_id}
              {s.mode === "manual" && <span className="ml-2 align-middle text-[10px] font-bold text-white bg-[#7C3AED] px-1.5 py-0.5 rounded">MANUAL</span>}
            </div>
            <div className="text-[12px] text-ink-400 mt-0.5">
              <span className="font-medium text-ink-500">{s.patient_name}</span>
              {" · "}{fmtPhone(s.patient_number)} → {fmtPhone(s.practice_number)}
              {" · "}<span className="uppercase font-semibold">{s.env}</span>
              {" · "}{trig?.label}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {s.first_sms_latency_s > 0 && (
            <span className="pill pill-neutral" title="Time from call end to first AI SMS">
              <Zap className="w-3 h-3" strokeWidth={2} /> {s.first_sms_latency_s}s
            </span>
          )}
          {s.avg_reply_latency_s > 0 && (
            <span className="pill pill-neutral" title="Average agent reply latency">
              <Clock className="w-3 h-3" strokeWidth={2} /> {s.avg_reply_latency_s}s
            </span>
          )}
          {s.score > 0 && (
            <span className={`pill ${scorePill}`} title={s.judge_reason}>{s.score}/100</span>
          )}
          {s.outcome && (
            <span className={`pill ${outcomeOk ? "pill-ok" : "pill-warn"}`}>{s.outcome.replace(/_/g, " ")}</span>
          )}
          <span className={`pill ${STATUS_STYLES[s.status] ?? STATUS_STYLES.starting}`}>
            {active && <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />}
            {STATUS_LABEL[s.status] ?? s.status}
          </span>
          {active && s.trigger_type === "inbound_call" && (
            <LiveListen sessionId={s.session_id} />
          )}
          {active && (
            <button onClick={() => stop.mutate()} className="pill pill-bad hover:bg-[#FEE2E2] transition-colors">
              <Square className="w-3 h-3 fill-current" strokeWidth={0} /> Stop
            </button>
          )}
          {s.retell_id && (
            <a href={retellUrl(s)} target="_blank" rel="noopener noreferrer"
              title="Open this conversation in the Retell dashboard" className="pill pill-info hover:opacity-80 transition-opacity">
              Retell <ExternalLink className="w-3 h-3" strokeWidth={2} />
            </a>
          )}
          <button onClick={() => setExpanded(e => !e)}
            className="text-ink-400 hover:text-ink-700 p-1 transition-colors" title={expanded ? "Collapse" : "Expand"}>
            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} strokeWidth={2} />
          </button>
        </div>
      </div>

      {s.error && (
        <div className="mt-3 text-[12.5px] text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-3 py-2">
          {s.error}
        </div>
      )}
      {s.status === "failed" && !s.error && s.events.length > 0 && (
        <div className="mt-3 text-[12.5px] text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-3 py-2">
          {s.events[s.events.length - 1]?.msg}
        </div>
      )}
      {s.triage && (
        <div className="mt-2 text-[12px] text-[#B45309] bg-[#FFF7ED] border border-[#FED7AA] rounded-xl px-3 py-2 leading-relaxed">
          <span className="font-semibold">Why it failed:</span> {s.triage}
        </div>
      )}

      {s.recording_url && (
        <div className="mt-3 flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-500">
            <Volume2 className="w-4 h-4" strokeWidth={2} /> Recording ({s.recording_duration_s}s)
          </span>
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
                <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 ${iss.severity === "high" ? "text-[#B91C1C]" : "text-[#B45309]"}`} strokeWidth={2} />
                <span className={`text-[12.5px] font-semibold ${iss.severity === "high" ? "text-[#B91C1C]" : "text-[#B45309]"}`}>
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
          <div className="section-label mb-2">
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
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-400 font-medium" title={c.latency_ms > 0 ? "Time between Retell's tool-call invocation and result" : "Per-call timing not reported by Retell for this turn"}>
                    <Clock className="w-3 h-3" strokeWidth={2} /> {c.latency_ms > 0 ? `${c.latency_ms}ms` : "—"}
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
            <div className="section-label mb-2">Conversation ({s.turns.length})</div>
            {s.turns.length === 0 ? (
              <div className="text-[12.5px] text-ink-300 italic">No messages yet…</div>
            ) : (
              <div className="space-y-2 max-h-[340px] overflow-auto pr-1">
                {s.turns.map((t, i) => (
                  <div key={i} className={`flex ${t.role === "patient" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-[13px] leading-snug ${
                      t.role === "patient"
                        ? "bg-brand-500 text-white rounded-br-md"
                        : "bg-canvas-sunken text-ink-700 rounded-bl-md"
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
            <div className="section-label mb-2">Timeline</div>
            <div className="space-y-1.5 max-h-[340px] overflow-auto pr-1">
              {s.events.map((e, i) => (
                <div key={i} className="flex gap-2 text-[12px]">
                  <span className="text-ink-300 flex-shrink-0 font-mono">
                    {new Date(e.ts * 1000).toLocaleTimeString()}
                  </span>
                  <span className="text-ink-500">{e.msg}</span>
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
