import { useState, useRef } from "react";
import { Search, Play, Upload } from "lucide-react";
import { analyzeDebug, runValidation } from "../api";
import type { Config, DebugAnalysis, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";

interface Props {
  config: Config;
  onResults: (rs: SimResult[]) => void;
}

const SEV_COLOR: Record<string, string> = {
  critical: "#DC2626", high: "#EA580C", medium: "#D97706", low: "#16A34A",
};
const SEV_BG: Record<string, string> = {
  critical: "#FEF2F2", high: "#FFF7ED", medium: "#FFFBEB", low: "#F0FDF4",
};

export function DebugSuite({ config, onResults }: Props) {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [extraContext, setExtraContext] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<DebugAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [nRuns, setNRuns] = useState(3);
  const [validating, setValidating] = useState(false);
  const [validationResults, setValidationResults] = useState<SimResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File | null) => {
    setScreenshot(f);
    if (f) setScreenshotUrl(URL.createObjectURL(f));
    else setScreenshotUrl(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleAnalyze = async () => {
    if (!screenshot) return;
    if (!config.openaiKey) { setAnalysisError("OpenAI API key required in sidebar."); return; }
    setAnalysisError("");
    setAnalyzing(true);
    setResult(null);
    setValidationResults([]);
    try {
      const r = await analyzeDebug(screenshot, systemPrompt, extraContext, config.openaiKey);
      setResult(r);
    } catch (e: unknown) {
      setAnalysisError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleValidate = async () => {
    if (!result?.repro_opener) return;
    if (!config.bearerToken) { setAnalysisError("Bearer token required."); return; }
    setValidating(true);
    try {
      const res = await runValidation({
        repro_opener: result.repro_opener,
        root_cause: result.root_cause ?? "",
        n_runs: nRuns,
        api_base: config.apiBase,
        bearer_token: config.bearerToken,
        agent_phone: config.agentPhone,
        openai_key: config.openaiKey,
      });
      setValidationResults(res.results);
      onResults(res.results);
    } catch (e: unknown) {
      setAnalysisError(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setValidating(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Debug Suite</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Upload a conversation screenshot → paste your Retell prompt → get the exact line causing the bug
          + a suggested fix → auto-validate with simulations.
        </p>
      </div>

      {/* Input row */}
      <div className="grid grid-cols-2 gap-5 mb-4">
        {/* Left: prompt + context */}
        <div className="space-y-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">
              Step 1 — Paste Retell System Prompt
            </div>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={9}
              placeholder={"Paste your full Retell agent system prompt here.\n\nInclude everything: instructions, API call descriptions, edge cases.\nThe more complete this is, the more precise the diagnosis."}
              className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
            />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">
              Step 3 — What did you expect?
            </div>
            <textarea
              value={extraContext}
              onChange={e => setExtraContext(e.target.value)}
              rows={3}
              placeholder="e.g. 'Agent should have collected DOB before creating the task' or 'Should have offered available slots on Monday'"
              className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
            />
          </div>
        </div>

        {/* Right: screenshot */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">
            Step 2 — Upload Conversation Screenshot
          </div>
          <div
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="border-[1.5px] border-dashed border-[#DADAD8] rounded-xl cursor-pointer hover:border-brand-500 transition-colors h-[calc(100%-28px)] flex items-center justify-center bg-[#FAFAF8]"
          >
            {screenshotUrl ? (
              <img src={screenshotUrl} alt="screenshot" className="max-h-64 max-w-full rounded-lg object-contain" />
            ) : (
              <div className="text-center p-8">
                <Upload className="w-8 h-8 mx-auto mb-3 text-[#ADADAD]" />
                <div className="text-[13px] font-medium text-[#888]">Drop a screenshot here</div>
                <div className="text-[12px] text-[#ADADAD] mt-1">PNG, JPG, WEBP</div>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={e => handleFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </div>

      {analysisError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">
          {analysisError}
        </div>
      )}

      <button
        onClick={handleAnalyze}
        disabled={!screenshot || analyzing}
        className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-8 shadow-sm"
      >
        <Search className="w-4 h-4" />
        {analyzing ? "Analyzing with GPT-4o Vision…" : "Analyze Bug"}
      </button>

      {/* Results */}
      {result && !result.error && (
        <div>
          <div className="text-[12px] font-bold uppercase tracking-widest text-[#ADADAD] mb-4">Analysis Results</div>

          {/* Cards row */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-white border border-[#EAEAEA] rounded-xl p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">What Happened</div>
              <p className="text-[13.5px] text-[#222] leading-relaxed">{result.what_happened}</p>
            </div>
            <div className="bg-white border border-[#EAEAEA] rounded-xl p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Root Cause</div>
              <p className="text-[13.5px] text-[#222] leading-relaxed">{result.root_cause}</p>
            </div>
            <div
              className="rounded-xl p-4"
              style={{ background: SEV_BG[result.severity] ?? "#F9F9F9", border: "1px solid #EAEAEA" }}
            >
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Severity · Confidence</div>
              <div className="text-[18px] font-extrabold capitalize" style={{ color: SEV_COLOR[result.severity] ?? "#888" }}>
                {result.severity}
              </div>
              <div className="text-[12px] text-[#888] mt-0.5">Confidence: {result.confidence}</div>
            </div>
          </div>

          {/* Diff view */}
          {(result.prompt_section_at_fault || result.suggested_fix) && (
            <div className="grid grid-cols-2 gap-5 mb-5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">
                  Problematic Prompt Section
                </div>
                <div className="prompt-highlight">{result.prompt_section_at_fault || "No specific section identified"}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">
                  Suggested Fix
                </div>
                <div className="diff-new">{result.suggested_fix || "No fix suggested"}</div>
                {result.fix_explanation && (
                  <p className="text-[12px] text-[#888] mt-2 leading-relaxed">{result.fix_explanation}</p>
                )}
              </div>
            </div>
          )}

          {/* Before/After diff (shown if both sections exist) */}
          {result.prompt_section_at_fault && result.suggested_fix && systemPrompt && (
            <details className="mb-5 bg-white border border-[#EAEAEA] rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-5 py-3.5 text-[13px] font-semibold text-[#333] select-none">
                View Prompt Diff
              </summary>
              <div className="px-5 pb-4 pt-2">
                <div className="text-[10px] font-bold uppercase tracking-widest text-red-500 mb-1">Before (at fault)</div>
                <div className="diff-old">{result.prompt_section_at_fault}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-green-600 mb-1 mt-3">After (suggested)</div>
                <div className="diff-new">{result.suggested_fix}</div>
              </div>
            </details>
          )}

          <hr className="border-[#EAEAEA] mb-5" />

          {/* Reproduce & Validate */}
          <div className="text-[12px] font-bold uppercase tracking-widest text-[#ADADAD] mb-3">Reproduce &amp; Validate</div>

          {result.repro_opener && (
            <div className="bg-[#FAFAF8] border border-[#EAEAEA] rounded-xl p-4 mb-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-3">Auto-Generated Repro Scenario</div>
              <div className="text-[13px] text-[#222] mb-1.5">
                <strong>Opener:</strong> {result.repro_opener}
              </div>
              {result.repro_followups.map((f, i) => (
                <div key={i} className="text-[13px] text-[#555] ml-4">↳ {f}</div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-4 mb-4">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">Runs</label>
              <input
                type="number" min={1} max={5} value={nRuns}
                onChange={e => setNRuns(+e.target.value)}
                className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-brand-500"
              />
            </div>
            <button
              onClick={handleValidate}
              disabled={!result.repro_opener || validating}
              className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[13px] rounded-xl px-6 py-2.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm mt-5"
            >
              <Play className="w-3.5 h-3.5" />
              {validating ? "Running…" : "Run Validation Simulations"}
            </button>
          </div>

          {validationResults.length > 0 && (
            <>
              {(() => {
                const nP = validationResults.filter(r => r.passed).length;
                const nT = validationResults.length;
                const passColor = nP === nT ? "#059669" : nP === 0 ? "#DC2626" : "#D97706";
                const avgSc = Math.round(validationResults.reduce((a, r) => a + r.score, 0) / nT);
                return (
                  <div className="bg-white border border-[#EAEAEA] rounded-xl px-5 py-4 flex items-center gap-4 mb-4">
                    <div className="text-[28px] font-extrabold" style={{ color: passColor }}>{nP}/{nT}</div>
                    <div>
                      <div className="text-[14px] font-bold text-[#111]">
                        Validation {nP === nT ? "passed" : nP === 0 ? "failed" : "partial"}
                      </div>
                      <div className="text-[12.5px] text-[#888] mt-0.5">Avg score: {avgSc}/100</div>
                    </div>
                  </div>
                );
              })()}
              {validationResults.map((r, i) => (
                <SimResultCard key={i} result={r} defaultExpanded={false} />
              ))}
            </>
          )}
        </div>
      )}

      {result?.error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-[13px] text-red-700">
          Analysis failed: {result.error}
        </div>
      )}
    </div>
  );
}
