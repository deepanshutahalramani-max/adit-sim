/**
 * ManualSMS — live chat window connected to the real ADIT/Retell SMS agent.
 * The user types as a patient; messages are proxied through /api/sms/start
 * and /api/sms/send to the real agent backend.
 */
import { useState, useRef, useEffect } from "react";
import { Send, RefreshCw, MessageSquare } from "lucide-react";
import clsx from "clsx";
import { smsStart, smsSend } from "../api";

interface Props {
  config: {
    apiBase: string;
    bearerToken: string;
    agentPhone: string;
  };
}

interface Msg {
  role: "user" | "agent";
  text: string;
  api_events?: string[];
  latency_ms?: number;
  ts: number;
}

export function ManualSMS({ config }: Props) {
  const [messages, setMessages]     = useState<Msg[]>([]);
  const [input, setInput]           = useState("");
  const [sending, setSending]       = useState(false);
  const [error, setError]           = useState("");
  const [started, setStarted]       = useState(false);
  const [patientPhone, setPatientPhone] = useState("");
  const [chatId, setChatId]         = useState("");
  const [sessionDone, setSessionDone] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);
  const startTime = useRef(Date.now());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const elapsed = () => Math.floor((Date.now() - startTime.current) / 1000);

  const reset = () => {
    setMessages([]); setInput(""); setSending(false); setError("");
    setStarted(false); setPatientPhone(""); setChatId(""); setSessionDone(false);
    startTime.current = Date.now();
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const detectDone = (text: string) => {
    const lower = text.toLowerCase();
    const DONE_KWS = [
      "appointment is confirmed", "you're all set", "all set",
      "successfully booked", "appointment has been booked",
      "booking is confirmed", "appointment has been scheduled",
      "appointment has been rescheduled", "successfully rescheduled",
      "appointment has been cancelled", "successfully cancelled",
      "i've created a note", "created a note for the team",
      "team will reach out", "someone will reach out",
      "created a task", "your request has been sent",
    ];
    return DONE_KWS.some(kw => lower.includes(kw));
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!config.bearerToken) { setError("Bearer token required in sidebar."); return; }

    setInput("");
    setError("");
    setSending(true);

    const userMsg: Msg = { role: "user", text, ts: elapsed() };
    setMessages(prev => [...prev, userMsg]);

    try {
      let agentText = "";
      let apiEvents: string[] = [];
      let latency = 0;

      if (!started) {
        const res = await smsStart({
          api_base: config.apiBase,
          bearer_token: config.bearerToken,
          agent_phone: config.agentPhone,
          message: text,
        });
        setPatientPhone(res.patient_phone);
        setChatId(res.chat_id);
        setStarted(true);
        agentText  = res.agent_response;
        apiEvents  = res.api_events ?? [];
      } else {
        const res = await smsSend({
          api_base: config.apiBase,
          bearer_token: config.bearerToken,
          agent_phone: config.agentPhone,
          patient_phone: patientPhone,
          chat_id: chatId,
          message: text,
        });
        setChatId(res.chat_id || chatId);
        agentText  = res.agent_response;
        apiEvents  = res.api_events ?? [];
        latency    = res.latency_ms ?? 0;
      }

      if (agentText) {
        setMessages(prev => [...prev, {
          role: "agent", text: agentText,
          api_events: apiEvents, latency_ms: latency, ts: elapsed(),
        }]);
        if (detectDone(agentText)) setSessionDone(true);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const canSend = input.trim().length > 0 && !sending && !!config.bearerToken;

  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl overflow-hidden shadow-sm">
      {/* ── Header ── */}
      <div className="bg-[#075E54] px-5 py-3.5 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center flex-shrink-0">
          <MessageSquare className="w-4.5 h-4.5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-white leading-tight">Siriyaa · Dental Office</div>
          <div className="text-[11px] text-white/60 mt-0.5">
            {!started ? "Type a message to start" : sessionDone ? "Session complete" : "Connected · Real SMS agent"}
          </div>
        </div>
        {patientPhone && (
          <div className="text-[10px] text-white/40 font-mono">{patientPhone}</div>
        )}
        <button
          onClick={reset}
          className="flex items-center gap-1 text-[11px] font-semibold text-white/70 hover:text-white transition-colors"
          title="New conversation"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          New
        </button>
      </div>

      {/* ── Message window ── */}
      <div className="h-96 overflow-y-auto px-4 py-4 space-y-3 bg-[#ECE5DD]">
        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-full bg-[#25D366] flex items-center justify-center mb-3">
              <MessageSquare className="w-6 h-6 text-white" />
            </div>
            <div className="text-[13px] font-semibold text-[#555]">Chat with the real Siriyaa SMS agent</div>
            <div className="text-[12px] text-[#888] mt-1">Type your first message below to begin</div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i}>
            {/* API event pills (above agent bubble) */}
            {m.role === "agent" && m.api_events && m.api_events.length > 0 && (
              <div className="flex flex-col items-center gap-1 my-2">
                {m.api_events.map((ev, j) => (
                  <div key={j} className="flex items-center gap-2 bg-white/80 border border-[#C7D7FD] rounded-full px-3 py-1 shadow-sm">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                    <span className="text-[11px] font-semibold text-blue-700">{ev}</span>
                  </div>
                ))}
              </div>
            )}

            <div className={clsx(
              "flex",
              m.role === "user" ? "justify-end" : "justify-start",
            )}>
              <div className={clsx(
                "max-w-[78%] rounded-2xl px-3.5 py-2 shadow-sm",
                m.role === "user"
                  ? "bg-[#DCF8C6] rounded-tr-sm"
                  : "bg-white rounded-tl-sm",
              )}>
                <div className="text-[13.5px] text-[#111] leading-relaxed whitespace-pre-wrap">
                  {m.text}
                </div>
                <div className={clsx(
                  "flex items-center gap-1.5 mt-1",
                  m.role === "user" ? "justify-end" : "justify-start",
                )}>
                  <span className="text-[10px] text-[#999]">
                    {String(Math.floor(m.ts / 60)).padStart(2, "0")}:{String(m.ts % 60).padStart(2, "0")}
                  </span>
                  {m.latency_ms ? (
                    <span className="text-[10px] text-[#ADADAD]">{m.latency_ms}ms</span>
                  ) : null}
                  {m.role === "user" && <span className="text-[10px] text-[#34B7F1]">✓✓</span>}
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-white rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[#999] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-[#999] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-[#999] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}

        {/* Session-done banner */}
        {sessionDone && (
          <div className="flex justify-center">
            <div className="bg-white/80 border border-[#C6E8CA] rounded-full px-4 py-1.5 text-[11.5px] font-semibold text-[#3B8A4A] shadow-sm">
              ✓ Conversation complete
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Error bar ── */}
      {error && (
        <div className="bg-red-50 border-t border-red-200 px-4 py-2 text-[12px] text-red-600 flex items-center gap-2">
          ⚠ {error}
          <button onClick={() => setError("")} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* ── Input bar ── */}
      <div className="bg-[#F0F0F0] px-3 py-2.5 flex items-center gap-2 border-t border-[#DADAD8]">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={!config.bearerToken}
          placeholder={config.bearerToken ? "Type a message…" : "Bearer token required in sidebar"}
          className="flex-1 bg-white rounded-full px-4 py-2 text-[13.5px] text-[#111] border border-[#DADAD8] focus:outline-none focus:border-[#25D366] placeholder:text-[#ADADAD] disabled:opacity-50"
        />
        <button
          onClick={sendMessage}
          disabled={!canSend}
          className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center flex-shrink-0 disabled:opacity-40 hover:bg-[#20C45E] transition-colors shadow-sm"
        >
          <Send className="w-4 h-4 text-white" />
        </button>
      </div>
    </div>
  );
}
