import { useState } from "react";
import { Zap } from "lucide-react";
import { generateScenarios, runGeneratedScenario } from "../api";
import type { Config, GeneratedScenario, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";

interface Props {
  config: Config;
  onResults: (rs: SimResult[]) => void;
}

export function TestGenerator({ config, onResults }: Props) {
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedScenario[]>([]);
  const [results, setResults] = useState<SimResult[]>([]);
  const [error, setError] = useState("");
  const [runningIdx, setRunningIdx] = useState(-1);

  const handleGenerate = async () => {
    if (!config.openaiKey) { setError("OpenAI key required."); return; }
    if (!instruction.trim()) { setError("Enter a test description."); return; }
    if (!config.bearerToken) { setError("Bearer token required."); return; }
    setError("");
    setGenerating(true);
    setGenerated([]);
    setResults([]);
    try {
      const scenarios = await generateScenarios({ instruction, openai_key: config.openaiKey });
      setGenerated(scenarios);
      // Run each generated scenario sequentially
      const all: SimResult[] = [];
      for (let i = 0; i < scenarios.length; i++) {
        setRunningIdx(i);
        try {
          const r = await runGeneratedScenario({
            scenario_name: scenarios[i].name,
            goal: scenarios[i].goal,
            opener: scenarios[i].opener,
            api_base: config.apiBase,
            bearer_token: config.bearerToken,
            agent_phone: config.agentPhone,
            openai_key: config.openaiKey,
          });
          all.push(r);
          setResults([...all]);
        } catch (e: unknown) {
          console.error("Scenario run failed:", e);
        }
      }
      onResults(all);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
      setRunningIdx(-1);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Test Generator</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Describe what you want to test in plain English — GPT-4o-mini generates
          realistic scenarios and runs them automatically.
        </p>
      </div>

      <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-4">
        <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-2">
          Test Description
        </label>
        <textarea
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          rows={4}
          placeholder={"e.g. 'Test that the agent correctly handles a patient who initially asks about insurance, then decides to book, but wants to reschedule twice before confirming'"}
          className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
          {error}
        </div>
      )}

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl px-8 py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-6 shadow-sm"
      >
        <Zap className="w-4 h-4" />
        {generating ? "Generating & Running…" : "Generate & Run Tests"}
      </button>

      {generated.length > 0 && (
        <div className="mb-4 bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl px-5 py-3 text-[13px] text-[#166534]">
          Generated {generated.length} scenario{generated.length !== 1 ? "s" : ""}.
          {runningIdx >= 0 && ` Running: ${generated[runningIdx]?.name}…`}
        </div>
      )}

      {/* Generated scenario list (before running) */}
      {generated.length > 0 && results.length === 0 && (
        <div className="space-y-2 mb-6">
          {generated.map((sc, i) => (
            <div key={i} className={`bg-white border rounded-xl px-5 py-3.5 ${runningIdx === i ? "border-brand-500 bg-brand-50" : "border-[#EAEAEA]"}`}>
              <div className="flex items-center gap-2">
                {runningIdx === i && (
                  <div className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                )}
                <div className="text-[13.5px] font-semibold text-[#111]">{sc.name}</div>
              </div>
              <div className="text-[12.5px] text-[#888] mt-0.5">{sc.goal}</div>
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {results.map((r, i) => (
        <SimResultCard key={i} result={r} defaultExpanded />
      ))}
    </div>
  );
}
