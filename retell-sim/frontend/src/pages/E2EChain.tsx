/**
 * E2EChain — runs Book → Reschedule → Cancel sequentially.
 *
 * SMS mode:  uses the real ADIT SMS backend (same phone number across phases)
 * Call mode: runs 3 sequential real Retell web calls in AI Caller mode
 *            (each phase auto-starts and auto-drives via GPT-4o-mini + TTS)
 */
import { useState } from "react";
import { Play, MessageSquare, Phone } from "lucide-react";
import { runChain } from "../api";
import type { Config, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";
import { LiveWebCall, type LiveWebCallDoneResult } from "../components/LiveWebCall";
import { PromptConfigurator } from "../components/PromptConfigurator";
import { useAgentName } from "../context/AgentNameContext";

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

type Channel = "sms" | "call";
type CallPhase = 0 | 1 | 2 | 3 | 4; // 0=idle, 1-3=active phase, 4=done

export function E2EChain({ config, onResults, chainResults }: Props) {
  const agentName = useAgentName();
  const [channel, setChannel] = useState<Channel>("sms");

  /* ── SMS chain ── */
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  /* ── Call chain ── */
  const [callPhase, setCallPhase]         = useState<CallPhase>(0);
  const [callKey, setCallKey]             = useState(0);
  const [callResults, setCallResults]     = useState<(LiveWebCallDoneResult | null)[]>([null, null, null]);
  const [callError, setCallError]         = useState("");

  /* ── SMS handlers ── */
  const handleSmsRun = async () => {
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

  /* ── Call chain handlers ── */
  const startCallChain = () => {
    if (!config.openaiKey) { setCallError("OpenAI key required in sidebar for AI Caller."); return; }
    setCallError("");
    setCallResults([null, null, null]);
    setCallPhase(1);
    setCallKey(k => k + 1);
  };

  const handleCallPhaseDone = (result: LiveWebCallDoneResult, phaseIdx: number) => {
    setCallResults(prev => {
      const next = [...prev];
      next[phaseIdx] = result;
      return next;
    });
    if (phaseIdx < 2) {
      // Auto-advance to next phase after a brief pause
      setTimeout(() => {
        setCallPhase((phaseIdx + 2) as CallPhase);
        setCallKey(k => k + 1);
      }, 2000);
    } else {
      setCallPhase(4);
    }
  };

  const resetCallChain = () => {
    setCallPhase(0);
    setCallResults([null, null, null]);
    setCallError("");
  };

  /* ── Channel switch clears results ── */
  const switchChannel = (ch: Channel) => {
    setChannel(ch);
    setError(""); setCallError("");
    if (ch === "call") resetCallChain();
  };

  const allCallDone = callPhase === 4;
  const callPassCount = callResults.filter(r => r?.passed).length;

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Full E2E Chain</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Book → Reschedule → Cancel in sequence — exercises the full agent flow end-to-end.
        </p>
      </div>

      {/* ── Channel toggle ── */}
      <div className="flex gap-3 mb-6">
        {([
          { id: "sms",  icon: MessageSquare, label: "SMS",  badge: "Real SMS agent",  desc: "AI patient texts via ADIT backend — real booking API calls" },
          { id: "call", icon: Phone,          label: "Call", badge: "Real call agent", desc: "AI Caller talks to the real Retell voice agent via WebRTC" },
        ] as const).map(ch => {
          const Icon = ch.icon;
          const active = channel === ch.id;
          return (
            <button
              key={ch.id}
              onClick={() => switchChannel(ch.id)}
              className={`flex items-center gap-3 px-5 py-3.5 rounded-2xl border-2 transition-all text-left flex-1 max-w-[280px] ${
                active
                  ? ch.id === "sms"
                    ? "border-brand-500 bg-brand-50 shadow-sm"
                    : "border-[#1A1A1A] bg-[#F5F5F5] shadow-sm"
                  : "border-[#E5E5E5] bg-white hover:border-[#ADADAD]"
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                active ? (ch.id === "sms" ? "bg-brand-500" : "bg-[#1A1A1A]") : "bg-[#F0F0EE]"
              }`}>
                <Icon className={`w-5 h-5 ${active ? "text-white" : "text-[#888]"}`} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[14px] font-bold ${active ? "text-[#111]" : "text-[#555]"}`}>{ch.label}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                    active
                      ? ch.id === "sms" ? "bg-brand-100 text-brand-700" : "bg-[#E8E8E8] text-[#555]"
                      : "bg-[#F0F0EE] text-[#ADADAD]"
                  }`}>{ch.badge}</span>
                </div>
                <div className={`text-[11.5px] mt-0.5 leading-snug ${active ? "text-[#555]" : "text-[#ADADAD]"}`}>{ch.desc}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Info cards ── */}
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
          <div className="text-[11px] font-bold uppercase tracking-widest text-[#94A3B8] mb-3">
            {channel === "sms" ? "API Chain Covered" : "What's Tested"}
          </div>
          <div className="space-y-1.5 text-[13.5px] text-[#444]">
            {channel === "sms"
              ? ["Create New Patient", "Get Available Slots", "Book / Modify / Cancel Appointment", "Upcoming Appointment lookup", "Task Creation"].map(s => (
                <div key={s}>· {s}</div>
              ))
              : ["Full call agent conversation flow", "Booking intent handling", "Reschedule intent handling", "Cancellation intent handling", "Real Retell WebRTC session"].map(s => (
                <div key={s}>· {s}</div>
              ))
            }
          </div>
        </div>
      </div>

      {/* Prompt configurator — reflects active channel, toggles update live */}
      <div className="mb-6">
        <PromptConfigurator
          agentType={channel === "call" ? "call" : undefined}
          agentPhone={config.agentPhone}
          agentId={channel === "call" ? config.callAgentId : config.smsAgentId}
          apiBase={config.apiBase}
        />
      </div>

      {/* ══════════ SMS CHAIN ══════════ */}
      {channel === "sms" && (
        <>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{error}</div>
          )}
          <button
            onClick={handleSmsRun}
            disabled={running}
            className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-8 shadow-sm"
          >
            <Play className="w-4 h-4" />
            {running ? "Running Book → Reschedule → Cancel…" : "Run SMS Chain"}
          </button>

          {chainResults && (
            <>
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
                      <div className="text-[12px] text-[#ADADAD] mt-0.5">{r.score}/100 · {(r.total_ms / 1000).toFixed(1)}s</div>
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
        </>
      )}

      {/* ══════════ CALL CHAIN ══════════ */}
      {channel === "call" && (
        <div>
          {!config.openaiKey && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[12.5px] text-amber-700 mb-4">
              ⚠ OpenAI key required in sidebar — used for AI patient responses and TTS voice injection.
            </div>
          )}
          {callError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{callError}</div>
          )}

          {/* Phase summary cards */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            {PHASES.map((p, idx) => {
              const result = callResults[idx];
              const isActive = callPhase === idx + 1;
              const isPending = callPhase < idx + 1 && callPhase !== 4;
              return (
                <div key={p.id} className={`bg-white border rounded-xl p-4 transition-all ${
                  isActive  ? "border-green-400 shadow-md" :
                  result    ? "border-[#EAEAEA]" :
                              "border-[#F0F0EE] opacity-50"
                }`}>
                  <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">
                    {p.icon} {p.label}
                  </div>
                  {isActive ? (
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-green-600">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      In progress…
                    </div>
                  ) : result ? (
                    <>
                      <div className="text-[16px] font-bold text-[#111]">
                        {result.passed ? "✅ Passed" : "❌ Failed"}
                      </div>
                      <div className="text-[12px] text-[#ADADAD] mt-0.5">
                        {result.transcript.length} turns
                      </div>
                    </>
                  ) : (
                    <div className="text-[13px] text-[#ADADAD]">{isPending ? "Waiting…" : "—"}</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Start / Restart button */}
          {(callPhase === 0 || callPhase === 4) && (
            <button
              onClick={startCallChain}
              disabled={!config.openaiKey}
              className="w-full flex items-center justify-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-6 shadow-sm"
            >
              <Phone className="w-4 h-4" />
              {callPhase === 4 ? "Run Again" : "Run Call Chain"}
            </button>
          )}

          {/* All done summary */}
          {allCallDone && (
            <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border mb-6 ${
              callPassCount === 3 ? "bg-green-50 border-green-200" : callPassCount === 0 ? "bg-red-50 border-red-100" : "bg-amber-50 border-amber-200"
            }`}>
              <div className="text-[26px]">{callPassCount === 3 ? "✅" : callPassCount === 0 ? "❌" : "⚠️"}</div>
              <div>
                <div className={`text-[15px] font-bold ${callPassCount === 3 ? "text-green-700" : callPassCount === 0 ? "text-red-600" : "text-amber-700"}`}>
                  {callPassCount}/3 phases passed
                </div>
                <div className="text-[12.5px] text-[#888] mt-0.5">Real Retell call agent · AI Caller mode</div>
              </div>
            </div>
          )}

          {/* Active phase LiveWebCall */}
          {callPhase >= 1 && callPhase <= 3 && (
            <div className="mb-6">
              <div className="text-[13px] font-bold text-[#333] mb-3">
                {PHASES[callPhase - 1].icon} {PHASES[callPhase - 1].label} — Real Retell Call
              </div>
              <LiveWebCall
                key={callKey}
                params={{
                  mode: "ai",
                  openai_key: config.openaiKey,
                  scenario_id: PHASES[callPhase - 1].id,
                  autoStart: true,
                  agent_phone: config.agentPhone,
                }}
                onDone={result => handleCallPhaseDone(result, callPhase - 1)}
                onError={msg => { setCallError(`Phase ${callPhase} error: ${msg}`); setCallPhase(4); }}
              />
            </div>
          )}

          {/* Completed phase transcripts */}
          {callResults.some(r => r !== null) && (
            <div className="border-t border-[#EAEAEA] pt-6 space-y-6">
              {PHASES.map((p, idx) => {
                const r = callResults[idx];
                if (!r) return null;
                return (
                  <div key={p.id}>
                    <div className="text-[13px] font-bold text-[#333] mb-2">{p.icon} {p.label}</div>
                    <div className={`rounded-xl border p-4 text-[13px] ${r.passed ? "bg-green-50 border-green-200" : "bg-red-50 border-red-100"}`}>
                      <div className={`font-bold mb-2 ${r.passed ? "text-green-700" : "text-red-600"}`}>
                        {r.passed ? "✅ Goal reached" : "❌ Goal not reached"}
                        <span className="font-normal text-[#888] ml-2">{r.transcript.length} turns</span>
                      </div>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {r.transcript.map((t, i) => (
                          <div key={i} className={`flex gap-2 text-[12.5px] ${t.role === "agent" ? "text-green-800" : "text-[#555]"}`}>
                            <span className="font-bold flex-shrink-0 w-16">{t.role === "agent" ? agentName : "Caller"}:</span>
                            <span>{t.content}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
