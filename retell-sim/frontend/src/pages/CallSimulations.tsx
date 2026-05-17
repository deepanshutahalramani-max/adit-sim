/**
 * CallSimulations — dedicated call simulation hub.
 * Mirrors the SMS Simulations page but uses the voice call agent
 * and LLM-to-LLM simulation (no ADIT backend required).
 *
 * Sub-tabs:
 *   Live Run   — single call, real-time phone UI
 *   Batch Run  — multi-scenario parallel calls, aggregate stats
 */
import { useState, useRef } from "react";
import { Phone, Play, Trash2, RefreshCw } from "lucide-react";
import { runCallParallel } from "../api";
import type { Config, AppConfig, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";
import { PromptConfigurator } from "../components/PromptConfigurator";
import { LiveCall, type LiveCallDoneResult } from "../components/LiveCall";

interface Props {
  config: Config;
  appConfig?: AppConfig;
  onResults: (rs: SimResult[]) => void;
  results: SimResult[];
}

type SubTab = "live" | "batch";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-[#2D2D2D] rounded-xl px-5 py-4 shadow-sm">
      <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#888] mb-1">{label}</div>
      <div className="text-[28px] font-extrabold text-[#111] leading-none tracking-tight">{value}</div>
      {sub && <div className="text-[11px] text-[#ADADAD] mt-1">{sub}</div>}
    </div>
  );
}

export function CallSimulations({ config, appConfig, onResults, results }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
  const [subTab, setSubTab] = useState<SubTab>("live");

  /* ── Prompt ── */
  const [callPrompt, setCallPrompt] = useState("");
  const callPromptRef = useRef("");
  const handlePromptLoad = (p: string) => { setCallPrompt(p); callPromptRef.current = p; };

  /* ── Live Run state ── */
  const [liveScenario, setLiveScenario] = useState(scenarios[0]?.id ?? "new-patient-cleaning");
  const [liveKey, setLiveKey] = useState(0);
  const [liveRunning, setLiveRunning] = useState(false);
  const [liveDone, setLiveDone] = useState<LiveCallDoneResult | null>(null);
  const [liveError, setLiveError] = useState("");

  /* ── Batch Run state ── */
  const [selected, setSelected] = useState<string[]>([]);
  const [repeats, setRepeats] = useState(1);
  const [parallel, setParallel] = useState(3);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchError, setBatchError] = useState("");

  /* ── Handlers ── */
  const handleLiveRun = () => {
    if (!config.openaiKey) { setLiveError("OpenAI key required in sidebar."); return; }
    setLiveError("");
    setLiveDone(null);
    setLiveRunning(true);
    setLiveKey(k => k + 1);
  };

  const toggleScenario = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAll = () =>
    setSelected(s => s.length === scenarios.length ? [] : scenarios.map(sc => sc.id));

  const handleBatchRun = async () => {
    if (!config.openaiKey)    { setBatchError("OpenAI key required in sidebar."); return; }
    if (selected.length === 0) { setBatchError("Select at least one scenario."); return; }
    setBatchError("");
    setBatchRunning(true);
    try {
      const res = await runCallParallel({
        scenario_ids: selected,
        repeats,
        max_parallel: parallel,
        call_agent_prompt: callPromptRef.current,
        openai_key: config.openaiKey,
      });
      onResults(res.results);
    } catch (e: unknown) {
      setBatchError(e instanceof Error ? e.message : "Batch run failed");
    } finally {
      setBatchRunning(false);
    }
  };

  /* ── Stats ── */
  const nPass = results.filter(r => r.passed).length;
  const avgScore = results.length ? Math.round(results.reduce((a, b) => a + b.score, 0) / results.length) : 0;
  const avgMs = results.length ? results.reduce((a, b) => a + b.total_ms, 0) / results.length : 0;

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 bg-[#1A1A1A] rounded-xl flex items-center justify-center flex-shrink-0">
              <Phone className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight">Call Simulations</h1>
          </div>
          <p className="text-[13.5px] text-[#888] leading-relaxed">
            GPT-4o plays the voice call agent using its live Retell prompt.
            GPT-4o-mini acts as a natural phone caller. No actual calls are made.
          </p>
        </div>
      </div>

      {/* ── Prompt configurator (shared between tabs) ── */}
      <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-5">
        <PromptConfigurator agentType="call" onLoad={handlePromptLoad} />
        <details className="mt-3">
          <summary className="text-[11px] font-semibold text-[#ADADAD] cursor-pointer hover:text-[#888] select-none">
            Preview resolved prompt
          </summary>
          <textarea
            value={callPrompt}
            onChange={e => { setCallPrompt(e.target.value); callPromptRef.current = e.target.value; }}
            rows={5}
            placeholder="Loading call agent prompt…"
            className="mt-2 w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[12px] text-[#555] resize-none focus:outline-none focus:border-[#333]"
          />
        </details>
      </div>

      {/* ── Sub-tab bar ── */}
      <div className="flex border-b border-[#EAEAEA] mb-6">
        {([
          { id: "live",  label: "▶  Live Run",   desc: "Real-time phone call UI" },
          { id: "batch", label: "⚡  Batch Run",  desc: "Multiple scenarios in parallel" },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === t.id
                ? "border-[#1A1A1A] text-[#111] font-semibold"
                : "border-transparent text-[#888] hover:text-[#333]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════════ LIVE RUN ══════════════ */}
      {subTab === "live" && (
        <div>
          <div className="mb-4">
            <h2 className="text-[14px] font-bold text-[#111] mb-1">Live Call Simulation</h2>
            <p className="text-[13px] text-[#888]">
              Watch the conversation unfold in real-time — exactly how the call agent would handle the caller.
            </p>
          </div>

          {/* Scenario picker */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-4">
            <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-2">
              Caller Intent / Scenario
            </label>
            <div className="grid grid-cols-2 gap-2">
              {scenarios.map(sc => (
                <label
                  key={sc.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    liveScenario === sc.id
                      ? "border-[#1A1A1A] bg-[#F5F5F5]"
                      : "border-[#E5E5E5] hover:border-[#ADADAD]"
                  }`}
                >
                  <input
                    type="radio"
                    name="liveScenario"
                    value={sc.id}
                    checked={liveScenario === sc.id}
                    onChange={() => setLiveScenario(sc.id)}
                    className="mt-0.5 accent-[#1A1A1A]"
                  />
                  <div>
                    <div className="text-[13px] font-semibold text-[#111]">{sc.label}</div>
                    <div className="text-[11.5px] text-[#888] mt-0.5 leading-snug">{sc.goal}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {liveError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
              {liveError}
            </div>
          )}

          <button
            onClick={handleLiveRun}
            disabled={liveRunning || !config.openaiKey}
            className="flex items-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-5 shadow-sm"
          >
            <Phone className="w-4 h-4" />
            {liveRunning ? "Call in progress…" : "Start Call"}
          </button>

          {!config.openaiKey && (
            <p className="text-[12px] text-red-500 mb-4">OpenAI key required in sidebar.</p>
          )}

          {/* Live call stream */}
          {liveKey > 0 && (
            <div className="mb-5">
              <LiveCall
                key={liveKey}
                params={{
                  scenario_id: liveScenario,
                  call_agent_prompt: callPromptRef.current,
                  openai_key: config.openaiKey,
                  max_turns: 12,
                }}
                onDone={result => {
                  setLiveRunning(false);
                  setLiveDone(result);
                }}
                onError={msg => {
                  setLiveRunning(false);
                  setLiveError(msg);
                }}
              />
            </div>
          )}

          {/* Post-call card */}
          {liveDone && (
            <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border ${
              liveDone.passed ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
            }`}>
              <div className="text-[26px]">{liveDone.passed ? "✅" : "❌"}</div>
              <div>
                <div className={`text-[15px] font-bold ${liveDone.passed ? "text-green-700" : "text-red-600"}`}>
                  {liveDone.passed ? "Call completed successfully" : "Call did not reach goal"}
                </div>
                <div className="text-[12.5px] text-[#888] mt-0.5">
                  Outcome: {liveDone.outcome.replace(/_/g, " ")}
                </div>
              </div>
              <button
                onClick={handleLiveRun}
                className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-[#888] border border-[#E5E5E5] bg-white rounded-lg px-3 py-2 hover:border-[#ADADAD] transition-colors"
              >
                <RefreshCw className="w-3 h-3" /> Run again
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════════ BATCH RUN ══════════════ */}
      {subTab === "batch" && (
        <div>
          <div className="mb-4">
            <h2 className="text-[14px] font-bold text-[#111] mb-1">Batch Call Simulation</h2>
            <p className="text-[13px] text-[#888]">
              Run multiple scenarios in parallel. Great for regression testing after prompt changes.
            </p>
          </div>

          {/* Scenario multi-picker */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-semibold text-[#333]">Scenarios</span>
              <button
                onClick={toggleAll}
                className="text-[12px] text-[#555] font-medium hover:text-[#111]"
              >
                {selected.length === scenarios.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {scenarios.map(sc => (
                <label
                  key={sc.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    selected.includes(sc.id)
                      ? "border-[#1A1A1A] bg-[#F5F5F5]"
                      : "border-[#E5E5E5] hover:border-[#ADADAD]"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(sc.id)}
                    onChange={() => toggleScenario(sc.id)}
                    className="mt-0.5 accent-[#1A1A1A]"
                  />
                  <div>
                    <div className="text-[13px] font-semibold text-[#111]">{sc.label}</div>
                    <div className="text-[11.5px] text-[#888] mt-0.5 leading-snug">{sc.goal}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Options */}
          <div className="flex gap-3 mb-4">
            <div className="bg-white border border-[#EAEAEA] rounded-xl p-4 flex-1">
              <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                Runs per scenario
              </label>
              <input
                type="number" min={1} max={5} value={repeats}
                onChange={e => setRepeats(+e.target.value)}
                className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#333]"
              />
            </div>
            <div className="bg-white border border-[#EAEAEA] rounded-xl p-4 flex-1">
              <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                Max parallel calls
              </label>
              <input
                type="number" min={1} max={5} value={parallel}
                onChange={e => setParallel(+e.target.value)}
                className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#333]"
              />
              <div className="text-[10px] text-[#ADADAD] mt-1">Max 5 — each call uses GPT-4o</div>
            </div>
          </div>

          {batchError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
              {batchError}
            </div>
          )}

          <button
            onClick={handleBatchRun}
            disabled={batchRunning || !config.openaiKey}
            className="w-full flex items-center justify-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-8 shadow-sm"
          >
            <Play className="w-4 h-4" />
            {batchRunning
              ? `Running ${selected.length * repeats} call${selected.length * repeats > 1 ? "s" : ""}…`
              : `Run ${selected.length * repeats || 0} Call${selected.length * repeats > 1 ? "s" : ""}`}
          </button>

          {/* Stats */}
          {results.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-3 mb-6">
                <Stat
                  label="Pass Rate"
                  value={`${nPass}/${results.length}`}
                  sub={`${Math.round(100 * nPass / results.length)}% success`}
                />
                <Stat label="Avg Score" value={`${avgScore}/100`} />
                <Stat label="Avg Duration" value={`${(avgMs / 1000).toFixed(1)}s`} />
              </div>

              <div className="flex items-center justify-between mb-3">
                <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
                  Call Results ({results.length})
                </div>
                <button
                  onClick={() => onResults([])}
                  className="flex items-center gap-1.5 text-[12px] text-[#888] hover:text-red-600 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear
                </button>
              </div>

              {results.slice(0, 30).map((r, i) => (
                <SimResultCard
                  key={`${r.scenario}-${r.patient_phone}-${i}`}
                  result={r}
                  defaultExpanded={false}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
