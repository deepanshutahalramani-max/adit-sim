/**
 * CallSimulations — three modes for testing the call agent:
 *
 *   🎙️ Manual Call  — your mic + speaker connected to the REAL Retell call agent
 *   🤖 AI Caller    — GPT-4o-mini + TTS talks to the REAL Retell call agent automatically
 *   ⚡ AI Sim       — LLM-to-LLM simulation (fast batch, uses call agent prompt)
 */
import { useState, useRef } from "react";
import { Phone, Play, Trash2, RefreshCw, Paperclip, X } from "lucide-react";
import { runCallParallel, extractContextFromImage } from "../api";
import { useQueryClient } from "@tanstack/react-query";
import type { Config, AppConfig, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";
import { PromptConfigurator } from "../components/PromptConfigurator";
import { RegisteredPatientCard } from "../components/RegisteredPatientCard";
import { LiveCall, type LiveCallDoneResult } from "../components/LiveCall";
import { LiveWebCall, type LiveWebCallDoneResult } from "../components/LiveWebCall";

interface Props {
  config: Config;
  appConfig?: AppConfig;
  onResults: (rs: SimResult[]) => void;
  results: SimResult[];
}

type SubTab = "manual" | "ai-caller" | "ai-sim";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-[#2D2D2D] rounded-xl px-5 py-4 shadow-sm">
      <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#888] mb-1">{label}</div>
      <div className="text-[28px] font-extrabold text-[#111] leading-none tracking-tight">{value}</div>
      {sub && <div className="text-[11px] text-[#ADADAD] mt-1">{sub}</div>}
    </div>
  );
}

const CALL_SCENARIO_LABELS: Record<string, string> = {
  "new-patient-cleaning":    "🆕 New Patient – Cleaning",
  "dental-emergency":        "🚨 Dental Emergency",
  "existing-routine":        "📅 Existing Patient – Routine",
  "reschedule":              "🔄 Reschedule",
  "cancel":                  "❌ Cancel",
  "insurance-book":          "🏥 Insurance Check → Book",
  "office-hours-book":       "🕐 Office Hours → Book",
  "post-treatment-followup": "💊 Post-Treatment Follow-up",
};

export function CallSimulations({ config, appConfig, onResults, results }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState<SubTab>("manual");

  /* ── Shared prompt (used by AI Sim and AI Caller) ── */
  const [callPrompt, setCallPrompt] = useState("");
  const callPromptRef = useRef("");
  const handlePromptLoad = (p: string) => { setCallPrompt(p); callPromptRef.current = p; };

  /* ── Manual / AI Caller state (separate keys so switching tabs resets the component) ── */
  const [webCallScenario, setWebCallScenario]       = useState("new-patient-cleaning");
  const [manualCallKey, setManualCallKey]            = useState(0);
  const [aiCallerKey, setAiCallerKey]                = useState(0);
  const [webCallRunning, setWebCallRunning]          = useState(false);
  const [webCallDone, setWebCallDone]                = useState<LiveWebCallDoneResult | null>(null);
  const [webCallError, setWebCallError]              = useState("");

  /* ── AI Sim (LLM-to-LLM) state ── */
  const [simMode, setSimMode]           = useState<"live" | "batch">("live");
  const [liveScenario, setLiveScenario] = useState(scenarios[0]?.id ?? "new-patient-cleaning");
  const [liveKey, setLiveKey]           = useState(0);
  const [liveRunning, setLiveRunning]   = useState(false);
  const [liveDone, setLiveDone]         = useState<LiveCallDoneResult | null>(null);
  const [liveError, setLiveError]       = useState("");

  /* ── Batch state ── */
  const [selected, setSelected]     = useState<string[]>([]);
  const [repeats, setRepeats]       = useState(1);
  const [parallel, setParallel]     = useState(3);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchError, setBatchError] = useState("");

  /* ── Scenario context (AI Caller + AI Sim) ── */
  const [simContext, setSimContext]           = useState("");
  const [contextFile, setContextFile]        = useState<File | null>(null);
  const [extracting, setExtracting]          = useState(false);
  const [extractError, setExtractError]      = useState("");
  const contextFileRef                        = useRef<HTMLInputElement>(null);

  const handleContextFile = async (file: File) => {
    setContextFile(file);
    setExtractError("");
    if (!config.openaiKey) { setExtractError("OpenAI key required to extract context from image."); return; }
    setExtracting(true);
    try {
      const { context } = await extractContextFromImage(file, config.openaiKey);
      setSimContext(prev => prev ? `${prev}\n\n[From screenshot]: ${context}` : context);
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : "Failed to extract context");
    } finally {
      setExtracting(false);
    }
  };

  /* ── Clear shared call state when switching between manual / ai-caller tabs ── */
  const switchSubTab = (tab: SubTab) => {
    setSubTab(tab);
    // Reset done/error banners so manual call state doesn't bleed into AI Caller tab and vice versa
    setWebCallDone(null);
    setWebCallError("");
    setWebCallRunning(false);
  };

  /* ── Handlers ── */
  const startWebCall = (mode: "manual" | "ai") => {
    if (mode === "ai" && !config.openaiKey) {
      setWebCallError("OpenAI key required in sidebar for AI Caller mode."); return;
    }
    setWebCallError(""); setWebCallDone(null); setWebCallRunning(true);
    if (mode === "manual") setManualCallKey(k => k + 1);
    else                   setAiCallerKey(k => k + 1);
  };

  const handleLiveRun = () => {
    if (!config.openaiKey) { setLiveError("OpenAI key required in sidebar."); return; }
    setLiveError(""); setLiveDone(null); setLiveRunning(true); setLiveKey(k => k + 1);
  };

  const toggleScenario = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAll = () =>
    setSelected(s => s.length === scenarios.length ? [] : scenarios.map(sc => sc.id));

  const handleBatchRun = async () => {
    if (!config.openaiKey)    { setBatchError("OpenAI key required."); return; }
    if (selected.length === 0) { setBatchError("Select at least one scenario."); return; }
    setBatchError(""); setBatchRunning(true);
    try {
      const res = await runCallParallel({
        scenario_ids: selected, repeats, max_parallel: parallel,
        call_agent_prompt: callPromptRef.current, openai_key: config.openaiKey,
        extra_context: simContext,
      });
      onResults(res.results);
    } catch (e: unknown) {
      setBatchError(e instanceof Error ? e.message : "Batch run failed");
    } finally {
      setBatchRunning(false);
      qc.invalidateQueries({ queryKey: ["registeredPatient"] });
    }
  };

  const nPass    = results.filter(r => r.passed).length;
  const avgScore = results.length ? Math.round(results.reduce((a, b) => a + b.score, 0) / results.length) : 0;
  const avgMs    = results.length ? results.reduce((a, b) => a + b.total_ms, 0) / results.length : 0;

  const callScenarioIds = Object.keys(CALL_SCENARIO_LABELS);

  /* ── Shared context box rendered in AI Caller + AI Sim tabs ── */
  const ContextBox = (
    <div className="bg-white border border-[#EAEAEA] rounded-xl p-4 mb-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
          Scenario Context <span className="normal-case font-normal text-[#ADADAD]">(optional)</span>
        </span>
        {simContext && (
          <button onClick={() => { setSimContext(""); setContextFile(null); setExtractError(""); }}
            className="flex items-center gap-1 text-[11px] text-[#ADADAD] hover:text-red-500 transition-colors">
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>
      <div className="text-[11px] text-[#ADADAD] mb-2">
        Describe the patient, scenario details, or specific edge cases — the AI patient will use this context during the call.
      </div>
      <textarea
        value={simContext}
        onChange={e => setSimContext(e.target.value)}
        placeholder="e.g. Patient is calling about a broken crown, is anxious about cost, and has United Concordia insurance. They want to be seen today if possible."
        rows={3}
        className="w-full text-[12px] border border-[#E5E5E5] rounded-lg px-3 py-2 resize-none focus:outline-none focus:border-[#ADADAD] mb-2"
      />
      {/* Screenshot upload */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => contextFileRef.current?.click()}
          disabled={extracting}
          className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#555] border border-[#E5E5E5] rounded-lg px-3 py-1.5 hover:border-[#ADADAD] disabled:opacity-50 transition-colors bg-white"
        >
          <Paperclip className="w-3.5 h-3.5" />
          {extracting ? "Extracting…" : contextFile ? contextFile.name : "Upload screenshot"}
        </button>
        {contextFile && !extracting && (
          <button onClick={() => { setContextFile(null); if (contextFileRef.current) contextFileRef.current.value = ""; }}
            className="text-[11px] text-[#ADADAD] hover:text-red-500 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="text-[10.5px] text-[#ADADAD]">GPT-4o will extract scenario details from the image</span>
        <input ref={contextFileRef} type="file" accept="image/*" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleContextFile(f); }} />
      </div>
      {extractError && <div className="text-[11px] text-red-500 mt-1">{extractError}</div>}
    </div>
  );

  return (
    <div>
      {/* ── Prompt configurator — always visible, shared across all sub-tabs ── */}
      <div className="mb-5">
        <PromptConfigurator agentType="call" onLoad={handlePromptLoad} agentPhone={config.agentPhone} agentId={config.callAgentId} />
      </div>

      {/* ── Sub-tab bar ── */}
      <div className="flex border-b border-[#EAEAEA] mb-6">
        {([
          { id: "manual",    label: "🎙️  Manual Call",  badge: "Real agent" },
          { id: "ai-caller", label: "🤖  AI Caller",    badge: "Real agent" },
          { id: "ai-sim",    label: "⚡  AI Sim",       badge: "Fast batch" },
        ] as const).map(t => (
          <button key={t.id} onClick={() => switchSubTab(t.id)}
            className={`group px-5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === t.id
                ? "border-[#1A1A1A] text-[#111] font-semibold"
                : "border-transparent text-[#888] hover:text-[#333]"
            }`}>
            {t.label}
            <span className={`ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
              t.badge === "Real agent"
                ? "bg-green-100 text-green-700"
                : "bg-[#F0F0EE] text-[#888]"
            }`}>{t.badge}</span>
          </button>
        ))}
      </div>

      {/* ══════════ MANUAL CALL TAB ══════════ */}
      {subTab === "manual" && (
        <div>
          <div className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl px-5 py-3.5 mb-5 flex items-start gap-3">
            <div className="text-[20px] mt-0.5">🎙️</div>
            <div>
              <div className="text-[13px] font-bold text-green-800 mb-0.5">Connected to the real Retell call agent</div>
              <div className="text-[12.5px] text-green-700 leading-relaxed">
                Your microphone and speaker connect directly to the call agent via WebRTC.
                Speak as a patient — hear the real agent voice, see the live transcript.
                Use headphones to avoid echo.
              </div>
            </div>
          </div>

          {/* Scenario intent picker */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-5">
            <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-2">
              Your Caller Intent (for your reference)
            </label>
            <div className="grid grid-cols-2 gap-2">
              {callScenarioIds.map(id => (
                <label key={id} className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all text-[12.5px] ${
                  webCallScenario === id ? "border-green-500 bg-green-50" : "border-[#E5E5E5] hover:border-[#ADADAD]"
                }`}>
                  <input type="radio" name="webCallScenario" value={id}
                    checked={webCallScenario === id} onChange={() => setWebCallScenario(id)}
                    className="accent-green-600 flex-shrink-0" />
                  <span className="font-medium text-[#111]">{CALL_SCENARIO_LABELS[id]}</span>
                </label>
              ))}
            </div>
          </div>

          {webCallError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{webCallError}</div>
          )}

          {manualCallKey === 0 ? (
            <button onClick={() => startWebCall("manual")}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors shadow-sm mb-5">
              <Phone className="w-4 h-4" />
              Start Manual Call
            </button>
          ) : (
            <div className="mb-5">
              <LiveWebCall
                key={manualCallKey}
                params={{ mode: "manual", openai_key: config.openaiKey, scenario_id: webCallScenario, agent_phone: config.agentPhone, agent_id: config.callAgentId }}
                onDone={result => { setWebCallRunning(false); setWebCallDone(result); }}
                onError={msg => { setWebCallRunning(false); setWebCallError(msg); }}
              />
            </div>
          )}

          {webCallDone && (
            <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border mb-4 ${
              webCallDone.passed ? "bg-green-50 border-green-200" : "bg-[#F9F9F7] border-[#EAEAEA]"
            }`}>
              <div className="text-[24px]">{webCallDone.passed ? "✅" : "📞"}</div>
              <div>
                <div className={`text-[14px] font-bold ${webCallDone.passed ? "text-green-700" : "text-[#333]"}`}>
                  {webCallDone.passed ? "Goal reached" : "Call ended"}
                </div>
                <div className="text-[12px] text-[#888] mt-0.5">{webCallDone.transcript.length} transcript turns</div>
              </div>
              <button onClick={() => startWebCall("manual")}
                className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-[#888] border border-[#E5E5E5] bg-white rounded-lg px-3 py-2 hover:border-[#ADADAD]">
                <RefreshCw className="w-3 h-3" /> Call again
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════ AI CALLER TAB ══════════ */}
      {subTab === "ai-caller" && (
        <div>
          <div className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl px-5 py-3.5 mb-5 flex items-start gap-3">
            <div className="text-[20px] mt-0.5">🤖</div>
            <div>
              <div className="text-[13px] font-bold text-green-800 mb-0.5">AI patient calls the real Retell agent</div>
              <div className="text-[12.5px] text-green-700 leading-relaxed">
                GPT-4o-mini generates the patient's spoken responses → OpenAI TTS converts to audio →
                injected into the real Retell WebRTC call. Watch the live transcript as it unfolds.
              </div>
            </div>
          </div>

          {/* Scenario picker */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-5">
            <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-2">
              Patient Scenario
            </label>
            <div className="grid grid-cols-2 gap-2">
              {callScenarioIds.map(id => (
                <label key={id} className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all text-[12.5px] ${
                  webCallScenario === id ? "border-green-500 bg-green-50" : "border-[#E5E5E5] hover:border-[#ADADAD]"
                }`}>
                  <input type="radio" name="aiCallerScenario" value={id}
                    checked={webCallScenario === id} onChange={() => setWebCallScenario(id)}
                    className="accent-green-600 flex-shrink-0" />
                  <span className="font-medium text-[#111]">{CALL_SCENARIO_LABELS[id]}</span>
                </label>
              ))}
            </div>
          </div>

          {ContextBox}

          {!config.openaiKey && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[12.5px] text-amber-700 mb-4">
              ⚠ OpenAI key required in sidebar — used for AI patient responses and TTS.
            </div>
          )}

          {webCallError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{webCallError}</div>
          )}

          {aiCallerKey === 0 ? (
            <button onClick={() => startWebCall("ai")} disabled={!config.openaiKey}
              className="flex items-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors shadow-sm mb-5 disabled:opacity-60 disabled:cursor-not-allowed">
              <Phone className="w-4 h-4" />
              Start AI Caller
            </button>
          ) : (
            <div className="mb-5">
              <LiveWebCall
                key={aiCallerKey}
                params={{ mode: "ai", openai_key: config.openaiKey, scenario_id: webCallScenario, extra_context: simContext, agent_phone: config.agentPhone, agent_id: config.callAgentId }}
                onDone={result => { setWebCallRunning(false); setWebCallDone(result); }}
                onError={msg => { setWebCallRunning(false); setWebCallError(msg); }}
              />
            </div>
          )}

          {webCallDone && (
            <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border mb-4 ${
              webCallDone.passed ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
            }`}>
              <div className="text-[24px]">{webCallDone.passed ? "✅" : "❌"}</div>
              <div>
                <div className={`text-[14px] font-bold ${webCallDone.passed ? "text-green-700" : "text-red-600"}`}>
                  {webCallDone.passed ? "AI caller reached the goal" : "AI caller did not reach goal"}
                </div>
                <div className="text-[12px] text-[#888] mt-0.5">{webCallDone.transcript.length} transcript turns · real Retell agent</div>
              </div>
              <button onClick={() => startWebCall("ai")}
                className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-[#888] border border-[#E5E5E5] bg-white rounded-lg px-3 py-2 hover:border-[#ADADAD]">
                <RefreshCw className="w-3 h-3" /> Run again
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════ AI SIM TAB (existing LLM-to-LLM) ══════════ */}
      {subTab === "ai-sim" && (
        <div>
          {ContextBox}

          {/* Registered patient — reused for existing-patient call scenarios */}
          <RegisteredPatientCard />

          <div className="flex gap-2 mb-6">
            {([
              { id: "live",  label: "▶  Live Run" },
              { id: "batch", label: "⚡  Batch Run" },
            ] as const).map(t => (
              <button key={t.id}
                onClick={() => setSimMode(t.id)}
                className={`px-4 py-2 text-[13px] font-semibold rounded-lg border transition-colors ${
                  simMode === t.id
                    ? "border-[#1A1A1A] bg-[#1A1A1A] text-white"
                    : "border-[#E5E5E5] bg-white text-[#555] hover:border-[#ADADAD]"
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Live run */}
          {simMode === "live" && <div className="mb-6">
            <div className="text-[13px] font-bold text-[#111] mb-3">▶ Live Run — single call</div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {scenarios.map(sc => (
                <label key={sc.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  liveScenario === sc.id ? "border-[#1A1A1A] bg-[#F5F5F5]" : "border-[#E5E5E5] hover:border-[#ADADAD]"
                }`}>
                  <input type="radio" name="liveScenario" value={sc.id}
                    checked={liveScenario === sc.id} onChange={() => setLiveScenario(sc.id)}
                    className="mt-0.5 accent-[#1A1A1A]" />
                  <div>
                    <div className="text-[13px] font-semibold text-[#111]">{sc.label}</div>
                    <div className="text-[11.5px] text-[#888] mt-0.5 leading-snug">{sc.goal}</div>
                  </div>
                </label>
              ))}
            </div>

            {liveError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{liveError}</div>
            )}

            <button onClick={handleLiveRun} disabled={liveRunning || !config.openaiKey}
              className="flex items-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-4 shadow-sm">
              <Phone className="w-4 h-4" />
              {liveRunning ? "Simulating…" : "Start Sim Call"}
            </button>

            {liveKey > 0 && (
              <div className="mb-4">
                <LiveCall key={liveKey}
                  params={{ scenario_id: liveScenario, call_agent_prompt: callPromptRef.current, openai_key: config.openaiKey, max_turns: 12, extra_context: simContext }}
                  onDone={r => { setLiveRunning(false); setLiveDone(r); }}
                  onError={msg => { setLiveRunning(false); setLiveError(msg); }} />
              </div>
            )}

            {liveDone && (
              <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border mb-4 ${
                liveDone.passed ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
              }`}>
                <div className="text-[26px]">{liveDone.passed ? "✅" : "❌"}</div>
                <div>
                  <div className={`text-[14px] font-bold ${liveDone.passed ? "text-green-700" : "text-red-600"}`}>
                    {liveDone.passed ? "Call completed" : "Call did not reach goal"}
                  </div>
                  <div className="text-[12px] text-[#888] mt-0.5">Outcome: {liveDone.outcome.replace(/_/g, " ")}</div>
                </div>
                <button onClick={handleLiveRun}
                  className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-[#888] border border-[#E5E5E5] bg-white rounded-lg px-3 py-2 hover:border-[#ADADAD]">
                  <RefreshCw className="w-3 h-3" /> Run again
                </button>
              </div>
            )}
          </div>}

          {/* Batch run */}
          {simMode === "batch" && <div className="border-t border-[#EAEAEA] pt-6">
            <div className="text-[13px] font-bold text-[#111] mb-3">⚡ Batch Run — multiple scenarios</div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {scenarios.map(sc => (
                <label key={sc.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  selected.includes(sc.id) ? "border-[#1A1A1A] bg-[#F5F5F5]" : "border-[#E5E5E5] hover:border-[#ADADAD]"
                }`}>
                  <input type="checkbox" checked={selected.includes(sc.id)}
                    onChange={() => toggleScenario(sc.id)} className="mt-0.5 accent-[#1A1A1A]" />
                  <div className="text-[12.5px] font-medium text-[#111]">{sc.label}</div>
                </label>
              ))}
            </div>

            <div className="flex gap-3 mb-4">
              <div className="bg-white border border-[#EAEAEA] rounded-xl p-4">
                <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">Runs / scenario</label>
                <input type="number" min={1} max={3} value={repeats} onChange={e => setRepeats(+e.target.value)}
                  className="w-16 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#333]" />
              </div>
              <div className="bg-white border border-[#EAEAEA] rounded-xl p-4">
                <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">Max parallel</label>
                <input type="number" min={1} max={5} value={parallel} onChange={e => setParallel(+e.target.value)}
                  className="w-16 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#333]" />
              </div>
            </div>

            {batchError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{batchError}</div>
            )}

            <div className="flex items-center gap-3 mb-2">
              <button onClick={toggleAll} className="text-[12px] text-[#888] hover:text-[#333] transition-colors">
                {selected.length === scenarios.length ? "Deselect all" : "Select all"}
              </button>
            </div>

            <button onClick={handleBatchRun} disabled={batchRunning || selected.length === 0 || !config.openaiKey}
              className="w-full flex items-center justify-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-6 shadow-sm">
              <Play className="w-4 h-4" />
              {batchRunning ? "Running call simulations…" : "Run Batch"}
            </button>

            {results.length > 0 && (
              <>
                <div className="grid grid-cols-3 gap-3 mb-5">
                  <Stat label="Pass Rate" value={`${nPass}/${results.length}`} sub={`${Math.round(100 * nPass / results.length)}%`} />
                  <Stat label="Avg Score" value={`${avgScore}`} sub="out of 100" />
                  <Stat label="Avg Time"  value={`${(avgMs / 1000).toFixed(1)}s`} />
                </div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">Results ({results.length})</div>
                  <button onClick={() => onResults([])}
                    className="flex items-center gap-1.5 text-[12px] text-[#888] hover:text-red-600 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" /> Clear
                  </button>
                </div>
                {results.slice(0, 30).map((r, i) => (
                  <SimResultCard key={`${r.scenario}-${r.patient_phone}-${i}`} result={r} defaultExpanded={false} />
                ))}
              </>
            )}
          </div>}
        </div>
      )}
    </div>
  );
}
