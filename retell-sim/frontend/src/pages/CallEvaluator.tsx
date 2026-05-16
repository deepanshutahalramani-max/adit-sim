import { useState } from "react";
import { BarChart2, Play } from "lucide-react";
import { evaluateTranscript, runParallel } from "../api";
import type { Config, AppConfig, TranscriptEval, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";

interface Props {
  config: Config;
  appConfig?: AppConfig;
  onResults: (rs: SimResult[]) => void;
}

type SubTab = "transcript" | "simulation";

function scoreColor(s: number) {
  if (s >= 80) return "#F5820D";
  if (s >= 60) return "#B45309";
  return "#DC2626";
}

export function CallEvaluator({ config, appConfig, onResults }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("transcript");

  // Transcript Analyzer state
  const [transcript, setTranscript] = useState("");
  const [sysPrompt, setSysPrompt] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [evalResult, setEvalResult] = useState<TranscriptEval | null>(null);
  const [evalError, setEvalError] = useState("");

  // Call Simulation state
  const scenarios = appConfig?.scenarios ?? [];
  const [simScenario, setSimScenario] = useState(scenarios[0]?.id ?? "");
  const [simRuns, setSimRuns] = useState(1);
  const [simRunning, setSimRunning] = useState(false);
  const [simResults, setSimResults] = useState<SimResult[]>([]);
  const [simError, setSimError] = useState("");

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

  const handleSimRun = async () => {
    if (!config.bearerToken) { setSimError("Bearer token required in sidebar."); return; }
    if (!config.openaiKey)   { setSimError("OpenAI key required."); return; }
    if (!simScenario)         { setSimError("Select a scenario."); return; }
    setSimError("");
    setSimRunning(true);
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

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Call Evaluator</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Evaluate Retell voice call quality — paste a call transcript for scoring,
          or run a voice call simulation using the same AI engine.
        </p>
      </div>

      {/* Sub-tab bar */}
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
            {t === "transcript" ? "Transcript Analyzer" : "Call Simulation"}
          </button>
        ))}
      </div>

      {/* Transcript Analyzer */}
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
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">
                System Prompt (optional)
              </div>
              <textarea
                value={sysPrompt}
                onChange={e => setSysPrompt(e.target.value)}
                rows={9}
                placeholder="Paste the Retell system prompt to get prompt-violation detection"
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
              {/* Score row */}
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
                    <div key={i} className="text-[13px] text-[#333] py-1.5 border-b border-[#F0F0EE]">
                      ✓ &nbsp;{item}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Issues Found</div>
                  {evalResult.issues.length === 0 ? (
                    <p className="text-[13px] text-[#888]">No issues found</p>
                  ) : evalResult.issues.map((item, i) => (
                    <div key={i} className="text-[13px] text-red-600 py-1.5 border-b border-[#FEE2E2]">
                      ✗ &nbsp;{item}
                    </div>
                  ))}
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

      {/* Call Simulation */}
      {subTab === "simulation" && (
        <div>
          <div className="mb-4">
            <h2 className="text-[15px] font-bold text-[#111] mb-1">Call Simulation</h2>
            <p className="text-[13px] text-[#888] leading-relaxed">
              Runs the same smart patient simulation engine as the SMS tab — the agent logic is identical
              for voice and SMS. Displays results in call transcript format.
            </p>
          </div>

          <div className="bg-[#FFF7ED] border border-[#FED7AA] rounded-xl px-4 py-3 mb-5 text-[13px] text-[#92400E]">
            <strong>Note:</strong> Call simulation uses the same SMS conversation engine (identical booking logic).
            The simulation is free and functionally equivalent to a live call.
          </div>

          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-4">
            <div className="flex gap-5 items-end">
              <div className="flex-1">
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
              <div>
                <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                  Runs
                </label>
                <input
                  type="number" min={1} max={5} value={simRuns}
                  onChange={e => setSimRuns(+e.target.value)}
                  className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>
          </div>

          {simError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
              {simError}
            </div>
          )}

          <button
            onClick={handleSimRun}
            disabled={simRunning}
            className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-6 shadow-sm"
          >
            <Play className="w-4 h-4" />
            {simRunning ? "Running…" : "Run Call Simulation"}
          </button>

          {simResults.map((r, i) => (
            <SimResultCard key={i} result={r} defaultExpanded />
          ))}
        </div>
      )}
    </div>
  );
}
