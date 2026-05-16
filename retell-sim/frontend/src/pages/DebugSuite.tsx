import { useState, useRef } from "react";
import {
  Upload, CheckCircle, AlertTriangle, Play,
  RefreshCw, ChevronRight, Copy, Check,
} from "lucide-react";
import clsx from "clsx";
import {
  analyzeDebug, analyzeDebugText, runValidation,
  applyFix, runRegression,
} from "../api";
import type { Config, DebugAnalysis, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";

interface Props {
  config: Config;
  onResults: (rs: SimResult[]) => void;
}

/* ─── Wizard state machine ─── */
type WizardStep =
  | "input"
  | "diagnosing"
  | "confirm_issue"
  | "reproducing"
  | "repro_done"
  | "confirm_fix"
  | "applying_fix"
  | "regression"
  | "done";

const STEP_NUMBERS: Record<WizardStep, number> = {
  input: 1,
  diagnosing: 2,
  confirm_issue: 2,
  reproducing: 3,
  repro_done: 3,
  confirm_fix: 4,
  applying_fix: 4,
  regression: 5,
  done: 5,
};

const STEPS = [
  { id: 1, label: "Upload Escalation" },
  { id: 2, label: "Confirm Issue" },
  { id: 3, label: "Reproduce" },
  { id: 4, label: "Confirm Fix" },
  { id: 5, label: "Regression" },
];

/* ─── Severity colours ─── */
const SEV_COLOR: Record<string, string> = {
  critical: "#DC2626", high: "#EA580C", medium: "#D97706", low: "#16A34A",
};
const SEV_BG: Record<string, string> = {
  critical: "#FEF2F2", high: "#FFF7ED", medium: "#FFFBEB", low: "#F0FDF4",
};

/* ════════════════════════════════════════════════════════════════════════════ */
export function DebugSuite({ config, onResults }: Props) {
  /* ── Step 1 inputs ── */
  const [inputMode, setInputMode] = useState<"screenshot" | "text">("screenshot");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [extraContext, setExtraContext] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  /* ── Wizard state ── */
  const [step, setStep] = useState<WizardStep>("input");
  const [error, setError] = useState("");

  /* ── Step 2 ── */
  const [diagnosis, setDiagnosis] = useState<DebugAnalysis | null>(null);

  /* ── Step 3 ── */
  const [reproResults, setReproResults] = useState<SimResult[]>([]);

  /* ── Step 4 + 5 ── */
  const [modifiedPrompt, setModifiedPrompt] = useState("");
  const [appliedInline, setAppliedInline] = useState(false);
  const [regressionResults, setRegressionResults] = useState<SimResult[]>([]);
  const [regressionSummary, setRegressionSummary] = useState<{
    total: number; passed: number; failed: number; pass_rate: number; avg_score: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  /* ─────────────────────── helpers ─────────────────────── */
  const handleFile = (f: File | null) => {
    setScreenshot(f);
    setScreenshotUrl(f ? URL.createObjectURL(f) : null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files[0] ?? null);
  };

  const copyPrompt = () => {
    navigator.clipboard.writeText(modifiedPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ─────────────────────── Step 1 → 2: analyze ─────────────────────── */
  const handleAnalyze = async () => {
    const hasInput = inputMode === "screenshot" ? !!screenshot : description.trim().length > 0;
    if (!hasInput) return;
    if (!config.openaiKey) { setError("OpenAI API key required in sidebar."); return; }
    setError("");
    setStep("diagnosing");
    try {
      let result: DebugAnalysis;
      if (inputMode === "screenshot" && screenshot) {
        result = await analyzeDebug(screenshot, systemPrompt, extraContext, config.openaiKey);
      } else {
        result = await analyzeDebugText({
          description,
          system_prompt: systemPrompt,
          extra_context: extraContext,
          openai_key: config.openaiKey,
        });
      }
      if (result.error) throw new Error(result.error);
      setDiagnosis(result);
      setStep("confirm_issue");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Analysis failed");
      setStep("input");
    }
  };

  /* ─────────────────────── Step 2 → 3: reproduce ─────────────────────── */
  const handleConfirmIssue = async () => {
    if (!diagnosis?.repro_opener) return;
    if (!config.bearerToken) { setError("Bearer token required in sidebar."); return; }
    setError("");
    setStep("reproducing");
    try {
      const res = await runValidation({
        repro_opener: diagnosis.repro_opener,
        root_cause: diagnosis.root_cause ?? "",
        n_runs: 2,
        api_base: config.apiBase,
        bearer_token: config.bearerToken,
        agent_phone: config.agentPhone,
        openai_key: config.openaiKey,
      });
      setReproResults(res.results);
      onResults(res.results);
      setStep("repro_done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Reproduction failed");
      setStep("confirm_issue");
    }
  };

  /* ─────────────────────── Step 3 → 4: view fix ─────────────────────── */
  const handleProceedToFix = () => setStep("confirm_fix");

  /* ─────────────────────── Step 4 → 5: apply + regression ─────────────────────── */
  const handleApplyFix = async () => {
    if (!diagnosis?.suggested_fix) return;
    setError("");
    setStep("applying_fix");
    try {
      const fixRes = await applyFix({
        prompt_text: systemPrompt,
        section_at_fault: diagnosis.prompt_section_at_fault ?? "",
        suggested_fix: diagnosis.suggested_fix,
      });
      setModifiedPrompt(fixRes.modified_prompt);
      setAppliedInline(fixRes.applied_inline);

      setStep("regression");
      const regRes = await runRegression({
        api_base: config.apiBase,
        bearer_token: config.bearerToken,
        agent_phone: config.agentPhone,
        openai_key: config.openaiKey,
        use_judge: config.useLlmJudge,
      });
      setRegressionResults(regRes.results);
      setRegressionSummary(regRes.summary);
      onResults(regRes.results);
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Fix or regression failed");
      setStep("confirm_fix");
    }
  };

  /* ─────────────────────── Reset ─────────────────────── */
  const handleReset = () => {
    setStep("input");
    setScreenshot(null);
    setScreenshotUrl(null);
    setDescription("");
    setSystemPrompt("");
    setExtraContext("");
    setDiagnosis(null);
    setReproResults([]);
    setModifiedPrompt("");
    setRegressionResults([]);
    setRegressionSummary(null);
    setError("");
  };

  /* ─────────────────────── Render ─────────────────────── */
  const activeStep = STEP_NUMBERS[step];

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Debug Suite</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Upload a client escalation → AI diagnoses the bug → auto-reproduces → identifies
          the exact prompt fault → applies fix → runs full regression.
        </p>
      </div>

      {/* ── Stepper ── */}
      <div className="flex items-center mb-8 overflow-x-auto pb-1">
        {STEPS.map((s, i) => {
          const isDone = s.id < activeStep;
          const isActive = s.id === activeStep;
          return (
            <div key={s.id} className="flex items-center flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className={clsx(
                  "w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold border-2 transition-all",
                  isDone
                    ? "bg-brand-500 border-brand-500 text-white"
                    : isActive
                      ? "bg-white border-brand-500 text-brand-500"
                      : "bg-white border-[#DADAD8] text-[#ADADAD]",
                )}>
                  {isDone ? "✓" : s.id}
                </div>
                <span className={clsx(
                  "text-[13px] font-medium hidden sm:block whitespace-nowrap",
                  isActive ? "text-[#111] font-bold" : isDone ? "text-brand-500" : "text-[#ADADAD]",
                )}>
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={clsx(
                  "mx-3 h-px flex-shrink-0 w-8",
                  isDone ? "bg-brand-500" : "bg-[#DADAD8]",
                )} />
              )}
            </div>
          );
        })}
      </div>

      {/* Global error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ══════════════════ STEP 1: INPUT ══════════════════ */}
      {step === "input" && (
        <div>
          {/* Toggle */}
          <div className="flex gap-2 mb-5">
            {(["screenshot", "text"] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setInputMode(mode)}
                className={clsx(
                  "px-4 py-2 text-[13px] font-semibold rounded-lg border transition-colors",
                  inputMode === mode
                    ? "bg-brand-500 text-white border-brand-500"
                    : "bg-white text-[#888] border-[#E5E5E5] hover:border-brand-500",
                )}
              >
                {mode === "screenshot" ? "📸 Screenshot" : "✏️ Text Description"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-5 mb-4">
            {/* Left: prompt + expected behaviour */}
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                  Retell System Prompt
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={e => setSystemPrompt(e.target.value)}
                  rows={9}
                  placeholder={
                    "Paste your full Retell agent system prompt here.\n\n" +
                    "Include everything: instructions, API call descriptions, edge cases.\n" +
                    "The more complete this is, the more precise the diagnosis."
                  }
                  className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                  Expected Behaviour <span className="text-[#DADAD8] normal-case font-normal">(optional)</span>
                </label>
                <textarea
                  value={extraContext}
                  onChange={e => setExtraContext(e.target.value)}
                  rows={3}
                  placeholder="e.g. 'Agent should have collected DOB before creating the task'"
                  className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
                />
              </div>
            </div>

            {/* Right: screenshot or text */}
            <div className="flex flex-col">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                {inputMode === "screenshot" ? "Escalation Screenshot" : "Describe the Escalation"}
              </label>

              {inputMode === "screenshot" ? (
                <>
                  <div
                    onDrop={handleDrop}
                    onDragOver={e => e.preventDefault()}
                    onClick={() => fileRef.current?.click()}
                    className="flex-1 border-[1.5px] border-dashed border-[#DADAD8] rounded-xl cursor-pointer hover:border-brand-500 transition-colors flex items-center justify-center bg-[#FAFAF8] min-h-[200px]"
                  >
                    {screenshotUrl ? (
                      <img
                        src={screenshotUrl}
                        alt="escalation screenshot"
                        className="max-h-64 max-w-full rounded-lg object-contain p-2"
                      />
                    ) : (
                      <div className="text-center p-8">
                        <Upload className="w-8 h-8 mx-auto mb-3 text-[#ADADAD]" />
                        <div className="text-[13px] font-medium text-[#888]">Drop screenshot here or click</div>
                        <div className="text-[12px] text-[#ADADAD] mt-1">PNG · JPG · WEBP</div>
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
                </>
              ) : (
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="flex-1 border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10 min-h-[200px]"
                  placeholder={
                    "Describe what the client reported. Include:\n" +
                    "• What the agent said\n" +
                    "• What the patient expected\n" +
                    "• Any specific phrases or context\n\n" +
                    "e.g. 'Patient texted asking to book for Tuesday. Agent said it doesn't have availability but it does. Patient called in frustrated.'"
                  }
                />
              )}
            </div>
          </div>

          <button
            onClick={handleAnalyze}
            disabled={inputMode === "screenshot" ? !screenshot : !description.trim()}
            className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            <ChevronRight className="w-4 h-4" />
            Analyze Escalation
          </button>
        </div>
      )}

      {/* ══════════════════ LOADING: diagnosing ══════════════════ */}
      {step === "diagnosing" && (
        <LoadingCard
          title="Analyzing escalation…"
          subtitle="GPT-4o is examining the issue and identifying the root cause"
        />
      )}

      {/* ══════════════════ STEP 2: CONFIRM ISSUE ══════════════════ */}
      {step === "confirm_issue" && diagnosis && (
        <div>
          <div className="bg-white border border-[#EAEAEA] rounded-2xl p-6 mb-5 shadow-sm">
            {/* Diagnosis header */}
            <div className="flex items-start gap-3 mb-5">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{
                  background: SEV_BG[diagnosis.severity] ?? "#F9F9F9",
                  border: `1.5px solid ${SEV_COLOR[diagnosis.severity] ?? "#ADADAD"}44`,
                }}
              >
                <AlertTriangle className="w-4 h-4" style={{ color: SEV_COLOR[diagnosis.severity] }} />
              </div>
              <div>
                <div className="text-[14px] font-bold text-[#111]">AI Diagnosis</div>
                <div className="text-[12.5px] text-[#888] mt-0.5">
                  Review the finding and confirm before proceeding to reproduction
                </div>
              </div>
            </div>

            {/* 3-card row */}
            <div className="grid grid-cols-3 gap-4 mb-5">
              <InfoBox label="What Happened" value={diagnosis.what_happened} />
              <InfoBox label="Root Cause" value={diagnosis.root_cause} />
              <div
                className="rounded-xl p-4"
                style={{ background: SEV_BG[diagnosis.severity] ?? "#FAFAF8", border: "1px solid #EAEAEA" }}
              >
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">
                  Severity · Confidence
                </div>
                <div
                  className="text-[22px] font-extrabold capitalize mb-0.5"
                  style={{ color: SEV_COLOR[diagnosis.severity] }}
                >
                  {diagnosis.severity}
                </div>
                <div className="text-[12px] text-[#888]">Confidence: {diagnosis.confidence}</div>
              </div>
            </div>

            {/* Prompt section at fault */}
            {diagnosis.prompt_section_at_fault && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-red-400 mb-2">
                  Prompt Section at Fault
                </div>
                <p className="text-[12.5px] text-red-800 font-mono leading-relaxed whitespace-pre-wrap">
                  {diagnosis.prompt_section_at_fault}
                </p>
              </div>
            )}
          </div>

          {/* CTA buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleConfirmIssue}
              disabled={!config.bearerToken}
              className="flex-1 flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              <CheckCircle className="w-4 h-4" />
              Yes, reproduce this issue
            </button>
            <button
              onClick={() => setStep("input")}
              className="px-6 py-3 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl hover:border-[#ADADAD] transition-colors"
            >
              ✕ Try again
            </button>
          </div>
          {!config.bearerToken && (
            <p className="text-[12px] text-red-500 mt-2">Bearer token required in sidebar to run simulations.</p>
          )}
        </div>
      )}

      {/* ══════════════════ LOADING: reproducing ══════════════════ */}
      {step === "reproducing" && (
        <LoadingCard
          title="Reproducing the bug…"
          subtitle="Running 2 simulations with the auto-generated repro scenario"
        />
      )}

      {/* ══════════════════ STEP 3: REPRO DONE ══════════════════ */}
      {step === "repro_done" && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Play className="w-5 h-5 text-brand-500" />
            <span className="text-[15px] font-bold text-[#111]">Reproduction complete</span>
          </div>

          {/* Repro scenario used */}
          {diagnosis?.repro_opener && (
            <div className="bg-[#FAFAF8] border border-[#EAEAEA] rounded-xl p-4 mb-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">
                Repro Scenario Used
              </div>
              <div className="text-[13px] text-[#222] mb-1.5">
                <strong>Opener:</strong> {diagnosis.repro_opener}
              </div>
              {diagnosis.repro_followups?.map((f, i) => (
                <div key={i} className="text-[13px] text-[#555] ml-4">↳ {f}</div>
              ))}
            </div>
          )}

          {/* Sim results */}
          {reproResults.length > 0 && (
            <div className="mb-5 space-y-3">
              {reproResults.map((r, i) => (
                <SimResultCard key={i} result={r} defaultExpanded={i === 0} />
              ))}
            </div>
          )}

          <button
            onClick={handleProceedToFix}
            disabled={!systemPrompt.trim() || !diagnosis?.suggested_fix}
            className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            <ChevronRight className="w-4 h-4" />
            Review proposed fix
          </button>
          {(!systemPrompt.trim() || !diagnosis?.suggested_fix) && (
            <p className="text-[12px] text-[#888] mt-2 text-center">
              {!systemPrompt.trim()
                ? "Paste your Retell prompt in Step 1 to enable fix application."
                : "No fix was suggested by the analysis."}
            </p>
          )}
        </div>
      )}

      {/* ══════════════════ STEP 4: CONFIRM FIX ══════════════════ */}
      {step === "confirm_fix" && diagnosis && (
        <div>
          <div className="bg-white border border-[#EAEAEA] rounded-2xl p-6 mb-5 shadow-sm">
            <div className="text-[14px] font-bold text-[#111] mb-4">Proposed prompt change</div>

            {diagnosis.fix_explanation && (
              <div className="bg-[#F0F9FF] border border-[#BAE6FD] rounded-xl px-4 py-3 mb-5 text-[13px] text-[#0369A1] leading-relaxed">
                {diagnosis.fix_explanation}
              </div>
            )}

            <div className="grid grid-cols-2 gap-5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-red-400 mb-2">
                  Before (at fault)
                </div>
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 font-mono text-[12.5px] text-red-800 leading-relaxed whitespace-pre-wrap min-h-[80px]">
                  {diagnosis.prompt_section_at_fault || "No specific section identified — fix will be appended."}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-green-600 mb-2">
                  After (proposed)
                </div>
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 font-mono text-[12.5px] text-green-800 leading-relaxed whitespace-pre-wrap min-h-[80px]">
                  {diagnosis.suggested_fix}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleApplyFix}
              className="flex-1 flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors shadow-sm"
            >
              <CheckCircle className="w-4 h-4" />
              Apply fix &amp; run full regression
            </button>
            <button
              onClick={() => setStep("repro_done")}
              className="px-6 py-3 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl hover:border-[#ADADAD] transition-colors"
            >
              ← Back
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════ LOADING: applying fix ══════════════════ */}
      {step === "applying_fix" && (
        <LoadingCard
          title="Applying fix…"
          subtitle="Updating the prompt and preparing to run all 8 regression scenarios"
        />
      )}

      {/* ══════════════════ LOADING: regression ══════════════════ */}
      {step === "regression" && (
        <LoadingCard
          title="Running full regression…"
          subtitle="Testing all 8 scenarios in parallel to verify the fix doesn't break anything else"
        />
      )}

      {/* ══════════════════ STEP 5 / DONE ══════════════════ */}
      {step === "done" && regressionSummary && (
        <div>
          {/* Summary card */}
          <div className="bg-white border border-[#EAEAEA] rounded-2xl p-6 mb-5 shadow-sm">
            <div className="flex items-center gap-4 mb-5">
              <div className={clsx(
                "w-16 h-16 rounded-2xl flex flex-col items-center justify-center flex-shrink-0",
                regressionSummary.pass_rate >= 90
                  ? "bg-green-50"
                  : regressionSummary.pass_rate >= 70
                    ? "bg-yellow-50"
                    : "bg-red-50",
              )}>
                <span className={clsx(
                  "text-[22px] font-extrabold leading-none",
                  regressionSummary.pass_rate >= 90
                    ? "text-green-600"
                    : regressionSummary.pass_rate >= 70
                      ? "text-yellow-600"
                      : "text-red-600",
                )}>
                  {regressionSummary.pass_rate}%
                </span>
                <span className="text-[10px] text-[#ADADAD] mt-0.5">pass rate</span>
              </div>
              <div>
                <div className="text-[16px] font-bold text-[#111]">
                  {regressionSummary.pass_rate >= 90
                    ? "Regression passed ✓"
                    : regressionSummary.pass_rate >= 70
                      ? "Regression partially passed"
                      : "Regression needs attention"}
                </div>
                <div className="text-[13px] text-[#888] mt-1">
                  {regressionSummary.passed}/{regressionSummary.total} scenarios passed
                  &nbsp;·&nbsp; avg score {regressionSummary.avg_score}/100
                </div>
              </div>
            </div>

            {/* Updated prompt view */}
            <details className="border-t border-[#EAEAEA] pt-4">
              <summary className="cursor-pointer text-[13px] font-semibold text-brand-500 select-none">
                View updated Retell prompt&nbsp;
                <span className="font-normal text-[#888]">
                  ({appliedInline ? "applied inline" : "appended to end"})
                </span>
              </summary>
              <pre className="mt-3 bg-[#F8F8F6] border border-[#EAEAEA] rounded-xl p-4 text-[12px] text-[#444] overflow-auto max-h-56 whitespace-pre-wrap font-mono leading-relaxed">
                {modifiedPrompt}
              </pre>
              <button
                onClick={copyPrompt}
                className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-brand-500 hover:underline"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied!" : "Copy to clipboard"}
              </button>
            </details>
          </div>

          {/* Individual scenario results */}
          {regressionResults.length > 0 && (
            <div className="space-y-3 mb-5">
              {regressionResults.map((r, i) => (
                <SimResultCard key={i} result={r} defaultExpanded={false} />
              ))}
            </div>
          )}

          <button
            onClick={handleReset}
            className="flex items-center gap-2 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl px-5 py-2.5 hover:border-brand-500 hover:text-brand-500 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Debug another escalation
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─── */

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#FAFAF8] border border-[#EAEAEA] rounded-xl p-4">
      <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">{label}</div>
      <p className="text-[13.5px] text-[#222] leading-relaxed">{value}</p>
    </div>
  );
}

function LoadingCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl p-12 flex flex-col items-center justify-center text-center shadow-sm">
      <div className="w-10 h-10 border-[3px] border-brand-500 border-t-transparent rounded-full animate-spin mb-5" />
      <div className="text-[15px] font-bold text-[#111] mb-1.5">{title}</div>
      <div className="text-[13px] text-[#888] max-w-xs leading-relaxed">{subtitle}</div>
    </div>
  );
}
