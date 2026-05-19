import { useState } from "react";
import { BarChart2, Play, Phone, MessageSquare, RefreshCw } from "lucide-react";
import { evaluateTranscript, runParallel } from "../api";
import type { Config, AppConfig, TranscriptEval, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";
import { PromptConfigurator } from "../components/PromptConfigurator";
import { LiveWebCall, type LiveWebCallDoneResult } from "../components/LiveWebCall";

interface Props {
  config: Config;
  appConfig?: AppConfig;
  onResults: (rs: SimResult[]) => void;
}

type SubTab = "transcript" | "simulation";
type SimMode = "chat" | "call";

function scoreColor(s: number) {
  if (s >= 80) return "#F5820D";
  if (s >= 60) return "#B45309";
  return "#DC2626";
}

export function CallEvaluator({ config, appConfig, onResults }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("transcript");

  /* ── Transcript Analyzer ── */
  const [transcript, setTranscript] = useState("");
  const [sysPrompt, setSysPrompt] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [evalResult, setEvalResult] = useState<TranscriptEval | null>(null);
  const [evalError, setEvalError] = useState("");

  /* ── Simulation shared ── */
  const scenarios = appConfig?.scenarios ?? [];
  const [simMode, setSimMode] = useState<SimMode>("chat");
  const [simScenario, setSimScenario] = useState(scenarios[0]?.id ?? "");
  const [simError, setSimError] = useState("");

  /* ── Chat simulation state ── */
  const [simRuns, setSimRuns] = useState(1);
  const [simRunning, setSimRunning] = useState(false);
  const [simResults, setSimResults] = useState<SimResult[]>([]);

  /* ── Call simulation state ── */
  const [callKey, setCallKey]   = useState(0);
  const [callRunning, setCallRunning] = useState(false);
  const [callDone, setCallDone] = useState<LiveWebCallDoneResult | null>(null);

  /* ── Handlers ── */
  const handleAnalyze = async () => {
    if (!transcript.trim()) return;
    if (!config.openaiKey) { setEvalError("OpenAI API key required in sidebar."); return; }
    setEvalError("");
    setAnalyzing(true);
    try {
      const r = await evaluateTranscript({ transcript, system_prompt: sysPrompt, openai_key: config.openaiKey });
      setEvalResult(r);
    } catch (e: unknown) {
      setEvalError(e instanceof Error ? e.message : "Evaluation failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleChatRun = async () => {
    if (!config.bearerToken) { setSimError("Bearer token required in sidebar."); return; }
    if (!config.openaiKey)   { setSimError("OpenAI key required."); return; }
    if (!simScenario)         { setSimError("Select a scenario."); return; }
    setSimError("");
    setSimRunning(true);
    setSimResults([]);
    try {
      const res = await runParallel({
        scenario_ids: [simScenario],
        repeats: simRuns,
        max_parallel: simRuns,
        api_base: config.apiBase,
        bearer_token: config.bearerToken,
        agent_phone: config.agentPhone,
        openai_key: config.openaiKey,
        use_judge: config.useLlmJudge,
      });
      setSimResults(res.results);
      onResults(res.results);
    } catch (e: unknown) {
      setSimError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setSimRunning(false);
    }
  };

  const handleCallRun = () => {
    if (!config.openaiKey) { setSimError("OpenAI key required."); return; }
    if (!simScenario)       { setSimError("Select a scenario."); return; }
    setSimError("");
    setCallDone(null);
    setCallRunning(true);
    setCallKey(k => k + 1);
  };

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Call Evaluator</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Evaluate Retell voice call quality — paste a call transcript for scoring,
          or run a live call or chat simulation.
        </p>
      </div>

      {/* ── Sub-tab bar ── */}
      <div className="flex border-b border-[#EAEAEA] mb-6">
        {(["transcript", "simulation"] as const).map(t => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`px-5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === t
                ? "border-brand-500 text-[#111] font-semibold"
                : "border-transparent text-[#888] hover:text-[#333]"
            }`}
          >
            {t === "transcript" ? "Transcript Analyzer" : "Simulation"}
          </button>
        ))}
      </div>

      {/* ══════════════════ TRANSCRIPT ANALYZER ══════════════════ */}
      {subTab === "transcript" && (
        <div>
          <div className="mb-3">
            <h2 className="text-[15px] font-bold text-[#111] mb-1">Paste a Retell Call Transcript</h2>
            <p className="text-[13px] text-[#888]">
              Copy the transcript from your Retell dashboard → paste it here → get a full QA score and issue breakdown.
            </p>
          </div>

          <div className="grid grid-cols-[3fr_2fr] gap-5 mb-4">
            <textarea
              value={transcript}
              onChange={e => setTranscript(e.target.value)}
              rows={11}
              placeholder={"Paste the full call transcript here.\n\nFormat: Speaker labels are helpful but not required.\nExample:\nUser: Hi I need to book an appointment\nAgent: Of course! Are you a new or existing patient?\n..."}
              className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
            />
            <div>
              <PromptConfigurator onLoad={setSysPrompt} className="mb-2" apiBase={config.apiBase} />
              <textarea
                value={sysPrompt}
                onChange={e => setSysPrompt(e.target.value)}
                rows={9}
                placeholder="Prompt loads automatically — or paste/edit manually"
                className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
              />
            </div>
          </div>

          {evalError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
              {evalError}
            </div>
          )}

          <button
            onClick={handleAnalyze}
            disabled={!transcript.trim() || analyzing}
            className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-6 shadow-sm"
          >
            <BarChart2 className="w-4 h-4" />
            {analyzing ? "Evaluating…" : "Analyze Transcript"}
          </button>

          {evalResult && !evalResult.error && (
            <div>
              <div className="grid grid-cols-4 gap-3 mb-5">
                {[
                  { label: "Score", value: `${evalResult.score}/100`, style: { color: scoreColor(evalResult.score) } },
                  { label: "Outcome", value: evalResult.outcome.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) },
                  { label: "Result", value: evalResult.passed ? "✅ Pass" : "❌ Fail" },
                  { label: "Tone", value: evalResult.tone.charAt(0).toUpperCase() + evalResult.tone.slice(1) },
                ].map(item => (
                  <div key={item.label} className="bg-white border border-brand-500 rounded-xl px-5 py-4 shadow-sm">
                    <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">{item.label}</div>
                    <div className="text-[22px] font-extrabold text-[#111] leading-tight" style={item.style}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-5 mb-5">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">What Went Well</div>
                  {evalResult.what_went_well.map((item, i) => (
                    <div key={i} className="text-[13px] text-[#333] py-1.5 border-b border-[#F0F0EE]">✓ &nbsp;{item}</div>
                  ))}
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Issues Found</div>
                  {evalResult.issues.length === 0
                    ? <p className="text-[13px] text-[#888]">No issues found</p>
                    : evalResult.issues.map((item, i) => (
                      <div key={i} className="text-[13px] text-red-600 py-1.5 border-b border-[#FEE2E2]">✗ &nbsp;{item}</div>
                    ))
                  }
                </div>
              </div>

              {evalResult.prompt_violations.length > 0 && (
                <div className="mb-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Prompt Violations</div>
                  {evalResult.prompt_violations.map((v, i) => (
                    <div key={i} className="prompt-highlight mb-1">{v}</div>
                  ))}
                </div>
              )}

              {evalResult.summary && (
                <div className="text-[13px] text-[#555] italic px-4 py-3 bg-[#FAFAF8] rounded-lg border-l-[3px] border-l-brand-500">
                  {evalResult.summary}
                </div>
              )}
            </div>
          )}

          {evalResult?.error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-[13px] text-red-700">
              Evaluation failed: {evalResult.error}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════ SIMULATION TAB ══════════════════ */}
      {subTab === "simulation" && (
        <div>
          {/* ── Mode toggle ── */}
          <div className="flex items-center gap-3 mb-6">
            <span className="text-[11px] font-bold uppercase tracking-widest text-[#ADADAD]">Mode</span>
            <div className="flex rounded-xl overflow-hidden border border-[#E5E5E5] bg-[#FAFAF8]">
              <button
                onClick={() => { setSimMode("chat"); setSimError(""); setSimResults([]); }}
                className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold transition-colors ${
                  simMode === "chat"
                    ? "bg-brand-500 text-white"
                    : "text-[#888] hover:text-[#333]"
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                💬 Chat (SMS)
              </button>
              <button
                onClick={() => { setSimMode("call"); setSimError(""); setCallDone(null); }}
                className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold transition-colors border-l border-[#E5E5E5] ${
                  simMode === "call"
                    ? "bg-[#1A1A1A] text-white"
                    : "text-[#888] hover:text-[#333]"
                }`}
              >
                <Phone className="w-3.5 h-3.5" />
                📞 Call (Voice)
              </button>
            </div>
          </div>

          {/* ── Scenario selector (shared) ── */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-4">
            <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
              Scenario
            </label>
            <select
              value={simScenario}
              onChange={e => setSimScenario(e.target.value)}
              className="w-full border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-brand-500"
            >
              {scenarios.map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>

          {simError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
              {simError}
            </div>
          )}

          {/* ════ CHAT MODE ════ */}
          {simMode === "chat" && (
            <div>
              <div className="bg-[#FFF7ED] border border-[#FED7AA] rounded-xl px-4 py-3 mb-5 text-[13px] text-[#92400E]">
                <strong>Chat simulation</strong> — AI patient texts the SMS agent via the live ADIT backend.
                Includes real API calls (booking, rescheduling, cancellation).
              </div>

              <div className="flex items-center gap-3 mb-4">
                <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">Runs</label>
                <input
                  type="number" min={1} max={5} value={simRuns}
                  onChange={e => setSimRuns(+e.target.value)}
                  className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-brand-500"
                />
              </div>

              <button
                onClick={handleChatRun}
                disabled={simRunning}
                className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-6 shadow-sm"
              >
                <Play className="w-4 h-4" />
                {simRunning ? "Running…" : "Run Chat Simulation"}
              </button>

              {simResults.map((r, i) => (
                <SimResultCard key={i} result={r} defaultExpanded />
              ))}
            </div>
          )}

          {/* ════ CALL MODE ════ */}
          {simMode === "call" && (
            <div>
              <div className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl px-4 py-3 mb-5 text-[13px] text-[#1A4D24] flex items-start gap-2">
                <span className="text-[18px] mt-0.5">📞</span>
                <div>
                  <strong>Real Retell call agent</strong> — AI Caller (GPT-4o-mini + OpenAI TTS) calls the
                  real Retell voice agent via WebRTC. Watch the live transcript as it unfolds.
                </div>
              </div>

              {!config.openaiKey && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-[12.5px] text-amber-700 mb-4">
                  ⚠ OpenAI key required in sidebar — used for AI patient responses and TTS.
                </div>
              )}

              <button
                onClick={handleCallRun}
                disabled={callRunning || !config.openaiKey}
                className="flex items-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-5 shadow-sm"
              >
                <Phone className="w-4 h-4" />
                {callRunning ? "Call in progress…" : "Start Call"}
              </button>

              {/* Real Retell call via LiveWebCall */}
              {callKey > 0 && (
                <div className="mb-5">
                  <LiveWebCall
                    key={callKey}
                    params={{
                      mode: "ai",
                      openai_key: config.openaiKey,
                      scenario_id: simScenario,
                      autoStart: true,
                    }}
                    onDone={result => {
                      setCallRunning(false);
                      setCallDone(result);
                    }}
                    onError={msg => {
                      setCallRunning(false);
                      setSimError(msg);
                    }}
                  />
                </div>
              )}

              {/* Post-call result */}
              {callDone && (
                <div className={`flex items-center gap-4 px-5 py-4 rounded-xl border mb-5 ${
                  callDone.passed ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
                }`}>
                  <div className="text-[26px]">{callDone.passed ? "✅" : "❌"}</div>
                  <div>
                    <div className={`text-[15px] font-bold ${callDone.passed ? "text-green-700" : "text-red-600"}`}>
                      {callDone.passed ? "Call completed successfully" : "Call did not complete goal"}
                    </div>
                    <div className="text-[12.5px] text-[#888] mt-0.5">
                      Real Retell agent · {callDone.transcript.length} transcript turns
                    </div>
                  </div>
                  <button
                    onClick={handleCallRun}
                    className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-[#888] border border-[#E5E5E5] bg-white rounded-lg px-3 py-2 hover:border-[#ADADAD] transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" /> Run again
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
