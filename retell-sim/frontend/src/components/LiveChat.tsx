/**
 * LiveChat — streams a single reproduction simulation via SSE.
 * Messages appear in real-time as they are sent/received.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { ApiCall } from "../types";
import { useAgentName } from "../context/AgentNameContext";

export interface LiveChatParams {
  repro_opener: string;
  root_cause: string;
  prescribed_followups: string[];
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
  max_turns?: number;
}

export interface LiveChatDoneResult {
  outcome: string;
  passed: boolean;
  reproduced: boolean; // true if conversation did NOT complete (bug likely shown)
}

interface ChatMsg {
  role: "patient" | "agent";
  message: string;
  latency_ms?: number;
  api_events?: string[];
}

interface Props {
  params: LiveChatParams;
  onDone: (result: LiveChatDoneResult) => void;
  onError?: (msg: string) => void;
}

export function LiveChat({ params, onDone, onError }: Props) {
  const agentName = useAgentName();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [apiCalls, setApiCalls] = useState<ApiCall[]>([]);
  const [status, setStatus] = useState<"connecting" | "running" | "done" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [showApiCalls, setShowApiCalls] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const run = async () => {
      try {
        const r = await fetch("/api/simulate/stream-repro", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repro_opener: params.repro_opener,
            root_cause: params.root_cause,
            prescribed_followups: params.prescribed_followups,
            api_base: params.api_base,
            bearer_token: params.bearer_token,
            agent_phone: params.agent_phone,
            openai_key: params.openai_key,
            max_turns: params.max_turns ?? 12,
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

            if (ev.type === "patient") {
              setMessages(m => [...m, { role: "patient", message: ev.message as string }]);
            } else if (ev.type === "agent") {
              setMessages(m => [...m, {
                role: "agent",
                message: ev.message as string,
                latency_ms: ev.latency_ms as number,
                api_events: ev.api_events as string[] | undefined,
              }]);
              if (ev.api_calls) setApiCalls(ev.api_calls as ApiCall[]);
            } else if (ev.type === "error") {
              if (ev.api_calls) setApiCalls(ev.api_calls as ApiCall[]);
              setErrorMsg(ev.message as string);
              setStatus("error");
              onError?.(ev.message as string);
              return;
            } else if (ev.type === "done") {
              if (ev.api_calls) setApiCalls(ev.api_calls as ApiCall[]);
              setStatus("done");
              const outcome = ev.outcome as string;
              const passed = ev.passed as boolean;
              // "reproduced" means the agent did NOT complete correctly
              onDone({ outcome, passed, reproduced: !passed });
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

  return (
    <div className="bg-white border border-[#EAEAEA] rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-[#F0F0EE] flex items-center gap-2">
        <div className={clsx(
          "w-2 h-2 rounded-full",
          status === "running" ? "bg-green-500 animate-pulse" :
          status === "done" ? "bg-brand-500" :
          status === "error" ? "bg-red-500" : "bg-[#DADAD8]",
        )} />
        <span className="text-[12px] font-semibold text-[#333]">Live simulation</span>
        <span className="ml-auto text-[11px] text-[#ADADAD] capitalize">{status}</span>
      </div>

      {/* Message window */}
      <div className="h-72 overflow-y-auto p-4 space-y-3 bg-[#FAFAF8]">
        {messages.map((m, i) =>
          m.role === "patient" ? (
            <div key={i} className="flex items-start gap-2.5">
              <div className="w-6 h-6 bg-[#F0F0EE] rounded-full flex items-center justify-center text-[12px] flex-shrink-0 mt-0.5">👤</div>
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">Patient</div>
                <div className="patient-bubble text-[13px] max-w-[340px]">{m.message}</div>
              </div>
            </div>
          ) : (
            <div key={i}>
              {/* Inline API event pills */}
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
                <div className="w-6 h-6 bg-[#FFF3E8] rounded-full flex items-center justify-center text-[12px] flex-shrink-0 mt-0.5">🤖</div>
                <div className="text-right">
                  <div className="text-[9.5px] font-bold uppercase tracking-widest text-[#D4620A] mb-1">
                    {agentName} {m.latency_ms ? <span className="text-[#ADADAD] normal-case font-normal">· {m.latency_ms}ms</span> : null}
                  </div>
                  <div className="agent-bubble text-[13px] max-w-[340px]">{m.message}</div>
                </div>
              </div>
            </div>
          )
        )}

        {/* Typing indicator */}
        {status === "running" && messages.length > 0 && messages[messages.length - 1].role === "patient" && (
          <div className="flex items-center gap-2.5 flex-row-reverse">
            <div className="w-6 h-6 bg-[#FFF3E8] rounded-full flex items-center justify-center text-[12px] flex-shrink-0">🤖</div>
            <div className="agent-bubble text-[13px] flex items-center gap-1 py-2.5">
              <span className="w-1.5 h-1.5 bg-[#D4620A] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-[#D4620A] rounded-full animate-bounce" style={{ animationDelay: "160ms" }} />
              <span className="w-1.5 h-1.5 bg-[#D4620A] rounded-full animate-bounce" style={{ animationDelay: "320ms" }} />
            </div>
          </div>
        )}

        {status === "connecting" && (
          <div className="flex items-center justify-center h-full text-[13px] text-[#ADADAD]">Connecting…</div>
        )}

        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-[12px] text-red-700">
            ⚠ {errorMsg}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* API calls footer */}
      {apiCalls.length > 0 && (
        <div className="border-t border-[#F0F0EE]">
          <button
            onClick={() => setShowApiCalls(s => !s)}
            className="w-full px-4 py-2 text-left text-[11px] font-semibold text-[#ADADAD] hover:bg-[#FAFAF8] transition-colors flex items-center gap-1.5"
          >
            <span className="text-brand-500">⚡</span>
            {apiCalls.length} API call{apiCalls.length !== 1 ? "s" : ""}
            <span className="ml-auto">{showApiCalls ? "▲" : "▼"}</span>
          </button>
          {showApiCalls && (
            <div className="px-4 pb-3 space-y-1">
              {apiCalls.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className={clsx(
                    "font-bold w-8 text-right flex-shrink-0",
                    c.status === 200 ? "text-green-600" : "text-red-500",
                  )}>
                    {c.status}
                  </span>
                  <span className="font-mono text-[#555] truncate">{c.endpoint}</span>
                  {c.latency_ms > 0 && (
                    <span className="text-[#ADADAD] ml-auto flex-shrink-0">{c.latency_ms}ms</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
