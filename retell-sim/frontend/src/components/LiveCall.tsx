/**
 * LiveCall — streams a voice call simulation via SSE.
 * Renders a phone-call-style UI with a running timer, transcript bubbles,
 * and a "call ended" state.
 */
import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";
import clsx from "clsx";

export interface LiveCallParams {
  scenario_id: string;
  call_agent_prompt: string;
  openai_key: string;
  max_turns?: number;
  /** Debug repro: override the scenario opener with this exact spoken line */
  repro_opener?: string;
  /** Debug repro: override the simulation goal with "Reproduce: <root_cause>" */
  root_cause?: string;
  /** Optional tester-provided scenario context for the AI patient caller */
  extra_context?: string;
}

export interface LiveCallDoneResult {
  outcome: string;
  passed: boolean;
}

interface CallMsg {
  role: "patient" | "agent";
  message: string;
  latency_ms?: number;
  api_events?: string[];
  ts: number; // elapsed seconds when message arrived
}

interface Props {
  params: LiveCallParams;
  onDone: (result: LiveCallDoneResult) => void;
  onError?: (msg: string) => void;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

export function LiveCall({ params, onDone, onError }: Props) {
  const [messages, setMessages] = useState<CallMsg[]>([]);
  const [status, setStatus] = useState<"connecting" | "running" | "done" | "error">("connecting");
  const [outcome, setOutcome] = useState<{ passed: boolean; label: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ── Timer ── */
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    if (status === "done" || status === "error") {
      if (timerRef.current) clearInterval(timerRef.current);
    }
  }, [status]);

  /* ── SSE stream ── */
  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    startRef.current = Date.now();

    const run = async () => {
      try {
        const r = await fetch("/api/simulate/call-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scenario_id: params.scenario_id,
            call_agent_prompt: params.call_agent_prompt,
            openai_key: params.openai_key,
            max_turns: params.max_turns ?? 12,
            ...(params.repro_opener  ? { repro_opener: params.repro_opener }   : {}),
            ...(params.root_cause    ? { root_cause: params.root_cause }       : {}),
            ...(params.extra_context ? { extra_context: params.extra_context } : {}),
          }),
          signal: ctrl.signal,
        });

        if (!r.ok) {
          const t = await r.text().catch(() => r.statusText);
          throw new Error(t);
        }
        if (!r.body) throw new Error("No response body");

        setStatus("running");
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let ev: Record<string, unknown>;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }

            const ts = Math.floor((Date.now() - startRef.current) / 1000);

            if (ev.type === "patient") {
              setMessages(m => [...m, { role: "patient", message: ev.message as string, ts }]);
            } else if (ev.type === "agent") {
              setMessages(m => [...m, {
                role: "agent",
                message: ev.message as string,
                latency_ms: ev.latency_ms as number,
                api_events: ev.api_events as string[] | undefined,
                ts,
              }]);
            } else if (ev.type === "error") {
              setErrorMsg(ev.message as string);
              setStatus("error");
              onError?.(ev.message as string);
              return;
            } else if (ev.type === "done") {
              const passed = ev.passed as boolean;
              const rawOutcome = ev.outcome as string;
              const label = rawOutcome === "booking_confirmed"
                ? "Appointment booked ✓"
                : rawOutcome === "task_created"
                ? "Task created for team ✓"
                : "Call ended — goal not reached";
              setOutcome({ passed, label });
              setStatus("done");
              onDone({ outcome: rawOutcome, passed });
              return;
            }
          }
        }
        setStatus("done");
      } catch (e: unknown) {
        if ((e as Error).name === "AbortError") return;
        const msg = (e as Error).message ?? "Stream error";
        setErrorMsg(msg);
        setStatus("error");
        onError?.(msg);
      }
    };

    run();
    return () => ctrl.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const isRunning = status === "running" || status === "connecting";

  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl overflow-hidden shadow-sm">
      {/* ── Phone header ── */}
      <div className={clsx(
        "px-5 py-3 flex items-center gap-3 transition-colors",
        isRunning ? "bg-[#1A1A1A]" : status === "done" ? "bg-[#1C2B1A]" : "bg-[#2B1A1A]",
      )}>
        {/* Status dot / icon */}
        <div className={clsx(
          "w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0",
          isRunning ? "bg-green-500" : status === "done" ? "bg-[#4CAF50]" : "bg-red-500",
        )}>
          {status === "done"
            ? <PhoneOff className="w-4 h-4 text-white" />
            : <Phone className={clsx("w-4 h-4 text-white", isRunning && "animate-pulse")} />
          }
        </div>

        {/* Call info */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-white leading-tight">
            {status === "connecting" ? "Dialing…"
              : status === "running" ? "Call in progress"
              : status === "done" ? "Call ended"
              : "Call failed"}
          </div>
          <div className="text-[11px] text-white/50 mt-0.5">
            {status === "done" || status === "error"
              ? `Duration ${formatTime(elapsed)}`
              : "Dental Office — Siriyaa AI"}
          </div>
        </div>

        {/* Timer */}
        <div className={clsx(
          "text-[15px] font-mono font-bold tabular-nums",
          isRunning ? "text-green-400" : "text-white/40",
        )}>
          {formatTime(elapsed)}
        </div>
      </div>

      {/* ── Transcript window ── */}
      <div className="h-80 overflow-y-auto p-4 space-y-3 bg-[#F7F7F5]">
        {status === "connecting" && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-10 h-10 border-[3px] border-[#22C55E] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <div className="text-[13px] text-[#888]">Connecting call…</div>
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "patient" ? (
            /* ── Caller (patient) — left side ── */
            <div key={i} className="flex items-start gap-2.5">
              <div className="w-7 h-7 bg-[#E8E8E6] rounded-full flex items-center justify-center text-[13px] flex-shrink-0 mt-0.5">
                📞
              </div>
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[9.5px] font-bold uppercase tracking-widest text-[#ADADAD]">Caller</span>
                  <span className="text-[9px] text-[#CBCBC8]">{formatTime(m.ts)}</span>
                </div>
                <div className="bg-white border border-[#E5E5E5] rounded-2xl rounded-tl-sm px-3.5 py-2 text-[13px] text-[#111] max-w-[300px] shadow-sm">
                  {m.message}
                </div>
              </div>
            </div>
          ) : (
            /* ── Agent — right side ── */
            <div key={i}>
              {/* API event pills */}
              {m.api_events && m.api_events.length > 0 && (
                <div className="flex flex-col items-center gap-1 my-2">
                  {m.api_events.map((ev, j) => (
                    <div key={j} className="flex items-center gap-2 bg-[#F0F5FF] border border-[#C7D7FD] rounded-full px-3 py-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                      <span className="text-[11px] font-semibold text-blue-700">{ev}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-start gap-2.5 flex-row-reverse">
                <div className="w-7 h-7 bg-[#E8F5E9] rounded-full flex items-center justify-center text-[13px] flex-shrink-0 mt-0.5">
                  🏥
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-2 mb-0.5 justify-end">
                    <span className="text-[9px] text-[#CBCBC8]">{formatTime(m.ts)}</span>
                    {m.latency_ms ? (
                      <span className="text-[9px] text-[#ADADAD]">{m.latency_ms}ms</span>
                    ) : null}
                    <span className="text-[9.5px] font-bold uppercase tracking-widest text-[#3B8A4A]">Siriyaa</span>
                  </div>
                  <div className="bg-[#EAF6EB] border border-[#C6E8CA] rounded-2xl rounded-tr-sm px-3.5 py-2 text-[13px] text-[#1A3D1E] max-w-[300px] shadow-sm text-left">
                    {m.message}
                  </div>
                </div>
              </div>
            </div>
          )
        )}

        {/* Typing indicator */}
        {status === "running" && messages.length > 0 && messages[messages.length - 1].role === "patient" && (
          <div className="flex items-center gap-2.5 flex-row-reverse">
            <div className="w-7 h-7 bg-[#E8F5E9] rounded-full flex items-center justify-center text-[13px] flex-shrink-0">🏥</div>
            <div className="bg-[#EAF6EB] border border-[#C6E8CA] rounded-2xl rounded-tr-sm px-3.5 py-2.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[#3B8A4A] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-[#3B8A4A] rounded-full animate-bounce" style={{ animationDelay: "160ms" }} />
              <span className="w-1.5 h-1.5 bg-[#3B8A4A] rounded-full animate-bounce" style={{ animationDelay: "320ms" }} />
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-[12px] text-red-700">
            ⚠ {errorMsg}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Call-ended footer ── */}
      {status === "done" && outcome && (
        <div className={clsx(
          "px-5 py-3 flex items-center gap-3 border-t",
          outcome.passed ? "bg-green-50 border-green-100" : "bg-red-50 border-red-100",
        )}>
          <PhoneOff className={clsx("w-4 h-4 flex-shrink-0", outcome.passed ? "text-green-600" : "text-red-500")} />
          <span className={clsx("text-[13px] font-semibold", outcome.passed ? "text-green-700" : "text-red-600")}>
            {outcome.label}
          </span>
          <span className="ml-auto text-[11px] text-[#ADADAD]">{formatTime(elapsed)}</span>
        </div>
      )}
    </div>
  );
}
