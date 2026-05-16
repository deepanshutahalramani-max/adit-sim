import { useState, useRef } from "react";
import {
  Upload, CheckCircle, AlertTriangle,
  RefreshCw, ChevronRight, Copy, Check, ArrowLeft,
} from "lucide-react";
import clsx from "clsx";
import {
  analyzeDebug, analyzeDebugText, applyFix, runRegression,
} from "../api";
import type { Config, DebugAnalysis, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";
import { LiveChat, type LiveChatDoneResult } from "../components/LiveChat";
import { PromptConfigurator } from "../components/PromptConfigurator";

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
  | "confirm_fix"
  | "applying_fix"
  | "regression"
  | "done";

const STEP_NUMBERS: Record<WizardStep, number> = {
  input: 1,
  diagnosing: 2, confirm_issue: 2,
  reproducing: 3,
  confirm_fix: 4, applying_fix: 4,
  regression: 5, done: 5,
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

const MAX_REPRO_RUNS = 15;

/* ─── Repro run result ─── */
interface ReproRun {
  id: number;
  result: LiveChatDoneResult;
}

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

  /* ── Step 2: editable diagnosis ── */
  const [diagnosis, setDiagnosis] = useState<DebugAnalysis | null>(null);
  const [editedWhatHappened, setEditedWhatHappened] = useState("");
  const [editedRootCause, setEditedRootCause] = useState("");
  const [editedApiContext, setEditedApiContext] = useState("");

  /* ── Step 3: repro runs ── */
  const [reproRuns, setReproRuns] = useState<ReproRun[]>([]);
  const [currentRunId, setCurrentRunId] = useState(0); // 0 = not running
  const [streamKey, setStreamKey] = useState(0); // forces LiveChat remount

  /* ── Step 4 + 5 ── */
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [modifiedPrompt, setModifiedPrompt] = useState("");
  const [appliedInline, setAppliedInline] = useState(false);
  const [regressionResults, setRegressionResults] = useState<SimResult[]>([]);
  const [regressionSummary, setRegressionSummary] = useState<{
    total: number; passed: number; failed: number; pass_rate: number; avg_score: number;
  } | null>(null);
  const [copied, setCopied] = useState<"modified" | "original" | null>(null);

  /* ─────────────────────── helpers ─────────────────────── */
  const handleFile = (f: File | null) => {
    setScreenshot(f);
    setScreenshotUrl(f ? URL.createObjectURL(f) : null);
  };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); handleFile(e.dataTransfer.files[0] ?? null); };

  const copy = (text: string, which: "modified" | "original") => {
    navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
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
        result = await analyzeDebugText({ description, system_prompt: systemPrompt, extra_context: extraContext, openai_key: config.openaiKey });
      }
      if (result.error) throw new Error(result.error);
      setDiagnosis(result);
      setEditedWhatHappened(result.what_happened);
      setEditedRootCause(result.root_cause);
      setEditedApiContext("");
      setStep("confirm_issue");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Analysis failed");
      setStep("input");
    }
  };

  /* ─────────────────────── Step 2 → 3: start first repro run ─────────────────────── */
  const handleConfirmIssue = () => {
    if (!config.bearerToken) { setError("Bearer token required in sidebar."); return; }
    if (!diagnosis) return;
    // Apply edits back to diagnosis
    const updated: DebugAnalysis = { ...diagnosis, what_happened: editedWhatHappened, root_cause: editedRootCause };
    setDiagnosis(updated);
    setReproRuns([]);
    setCurrentRunId(1);
    setStreamKey(k => k + 1);
    setStep("reproducing");
  };

  /* ─────────────────────── Repro run done ─────────────────────── */
  const handleRunDone = (result: LiveChatDoneResult) => {
    setReproRuns(prev => {
      const newRuns = [...prev, { id: currentRunId, result }];
      return newRuns;
    });
    setCurrentRunId(0); // stop streaming
  };

  /* ─────────────────────── Try another run (up to MAX) ─────────────────────── */
  const handleTryAnotherRun = () => {
    const nextId = reproRuns.length + 1;
    if (nextId > MAX_REPRO_RUNS) return;
    setCurrentRunId(nextId);
    setStreamKey(k => k + 1);
  };

  /* ─────────────────────── Step 3 → 4 ─────────────────────── */
  const handleProceedToFix = () => {
    setOriginalPrompt(systemPrompt);
    setStep("confirm_fix");
  };

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
    setStep("input"); setScreenshot(null); setScreenshotUrl(null);
    setDescription(""); setSystemPrompt(""); setExtraContext("");
    setDiagnosis(null); setReproRuns([]); setCurrentRunId(0);
    setOriginalPrompt(""); setModifiedPrompt(""); setRegressionResults([]);
    setRegressionSummary(null); setError("");
  };

  /* ─────────────────────── Derived ─────────────────────── */
  const activeStep = STEP_NUMBERS[step];
  const reproducedCount = reproRuns.filter(r => r.result.reproduced).length;
  const totalRuns = reproRuns.length;
  const isStreaming = currentRunId > 0;
  const canTryMore = !isStreaming && totalRuns < MAX_REPRO_RUNS && totalRuns > 0;

  /* ─────────────────────── Render ─────────────────────── */
  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Debug Suite</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          Upload a client escalation → AI diagnoses → confirm → live reproduce → confirm fix → apply → full regression.
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
                  isDone ? "bg-brand-500 border-brand-500 text-white" :
                  isActive ? "bg-white border-brand-500 text-brand-500" :
                  "bg-white border-[#DADAD8] text-[#ADADAD]",
                )}>
                  {isDone ? "✓" : s.id}
                </div>
                <span className={clsx(
                  "text-[13px] font-medium hidden sm:block whitespace-nowrap",
                  isActive ? "text-[#111] font-bold" : isDone ? "text-brand-500" : "text-[#ADADAD]",
                )}>{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={clsx("mx-3 h-px flex-shrink-0 w-8", isDone ? "bg-brand-500" : "bg-[#DADAD8]")} />
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
          <button onClick={() => setError("")} className="ml-auto text-[#ADADAD] hover:text-red-600">✕</button>
        </div>
      )}

      {/* ══════════════════ STEP 1: INPUT ══════════════════ */}
      {step === "input" && (
        <div>
          {/* Toggle */}
          <div className="flex gap-2 mb-5">
            {(["screenshot", "text"] as const).map(mode => (
              <button key={mode} onClick={() => setInputMode(mode)}
                className={clsx("px-4 py-2 text-[13px] font-semibold rounded-lg border transition-colors",
                  inputMode === mode ? "bg-brand-500 text-white border-brand-500" : "bg-white text-[#888] border-[#E5E5E5] hover:border-brand-500",
                )}>
                {mode === "screenshot" ? "📸 Screenshot" : "✏️ Text Description"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-5 mb-4">
            {/* Left */}
            <div className="space-y-4">
              <div>
                <PromptConfigurator onLoad={setSystemPrompt} />
                <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={9}
                  placeholder="Prompt loads automatically — or paste/edit manually"
                  className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                  Expected Behaviour <span className="text-[#DADAD8] normal-case font-normal">(optional)</span>
                </label>
                <textarea value={extraContext} onChange={e => setExtraContext(e.target.value)} rows={3}
                  placeholder="e.g. 'Agent should have collected DOB before creating the task'"
                  className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10" />
              </div>
            </div>

            {/* Right */}
            <div className="flex flex-col">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                {inputMode === "screenshot" ? "Escalation Screenshot" : "Describe the Escalation"}
              </label>
              {inputMode === "screenshot" ? (
                <>
                  <div onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => fileRef.current?.click()}
                    className="flex-1 border-[1.5px] border-dashed border-[#DADAD8] rounded-xl cursor-pointer hover:border-brand-500 transition-colors flex items-center justify-center bg-[#FAFAF8] min-h-[200px]">
                    {screenshotUrl
                      ? <img src={screenshotUrl} alt="escalation" className="max-h-64 max-w-full rounded-lg object-contain p-2" />
                      : <div className="text-center p-8">
                          <Upload className="w-8 h-8 mx-auto mb-3 text-[#ADADAD]" />
                          <div className="text-[13px] font-medium text-[#888]">Drop screenshot here or click</div>
                          <div className="text-[12px] text-[#ADADAD] mt-1">PNG · JPG · WEBP</div>
                        </div>}
                  </div>
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={e => handleFile(e.target.files?.[0] ?? null)} />
                </>
              ) : (
                <textarea value={description} onChange={e => setDescription(e.target.value)}
                  className="flex-1 border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10 min-h-[200px]"
                  placeholder={"Describe the escalation. Include:\n• What the agent said\n• What the patient expected\n• Any specific context\n\ne.g. 'Patient texted asking to book for Tuesday. Agent said no availability but there was. Patient called in frustrated.'"} />
              )}
            </div>
          </div>

          <button onClick={handleAnalyze}
            disabled={inputMode === "screenshot" ? !screenshot : !description.trim()}
            className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
            <ChevronRight className="w-4 h-4" />
            Analyze Escalation
          </button>
        </div>
      )}

      {/* ══════════════════ LOADING: diagnosing ══════════════════ */}
      {step === "diagnosing" && (
        <LoadingCard title="Analyzing escalation…" subtitle="GPT-4o is examining the issue and identifying the root cause" />
      )}

      {/* ══════════════════ STEP 2: CONFIRM ISSUE ══════════════════ */}
      {step === "confirm_issue" && diagnosis && (
        <div>
          <div className="bg-white border border-[#EAEAEA] rounded-2xl p-6 mb-5 shadow-sm">
            {/* Header */}
            <div className="flex items-start gap-3 mb-5">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: SEV_BG[diagnosis.severity] ?? "#F9F9F9", border: `1.5px solid ${SEV_COLOR[diagnosis.severity] ?? "#ADADAD"}44` }}>
                <AlertTriangle className="w-4 h-4" style={{ color: SEV_COLOR[diagnosis.severity] }} />
              </div>
              <div>
                <div className="text-[14px] font-bold text-[#111]">AI Diagnosis — review &amp; edit before confirming</div>
                <div className="text-[12.5px] text-[#888] mt-0.5">Edit any field below if the AI missed context (e.g. whether a booking API was actually called)</div>
              </div>
            </div>

            {/* Editable cards */}
            <div className="grid grid-cols-3 gap-4 mb-5">
              {/* What happened - editable */}
              <div className="bg-[#FAFAF8] border border-[#EAEAEA] rounded-xl p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">What Happened</div>
                <textarea value={editedWhatHappened} onChange={e => setEditedWhatHappened(e.target.value)} rows={4}
                  className="w-full bg-transparent text-[13px] text-[#222] leading-relaxed resize-none focus:outline-none border-b border-dashed border-[#DADAD8] focus:border-brand-500" />
              </div>

              {/* Root cause - editable */}
              <div className="bg-[#FAFAF8] border border-[#EAEAEA] rounded-xl p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Root Cause</div>
                <textarea value={editedRootCause} onChange={e => setEditedRootCause(e.target.value)} rows={4}
                  className="w-full bg-transparent text-[13px] text-[#222] leading-relaxed resize-none focus:outline-none border-b border-dashed border-[#DADAD8] focus:border-brand-500" />
              </div>

              {/* Severity + extra API context */}
              <div>
                <div className="rounded-xl p-4 mb-3" style={{ background: SEV_BG[diagnosis.severity] ?? "#FAFAF8", border: "1px solid #EAEAEA" }}>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">Severity · Confidence</div>
                  <div className="text-[22px] font-extrabold capitalize" style={{ color: SEV_COLOR[diagnosis.severity] }}>{diagnosis.severity}</div>
                  <div className="text-[12px] text-[#888]">Confidence: {diagnosis.confidence}</div>
                </div>
              </div>
            </div>

            {/* Extra API context field */}
            <div className="mb-5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                Additional API / Backend Context <span className="normal-case font-normal text-[#DADAD8]">(optional — info screenshot can't show)</span>
              </label>
              <textarea value={editedApiContext} onChange={e => setEditedApiContext(e.target.value)} rows={2}
                placeholder="e.g. 'The booking API was called and returned success (200)' or 'No API call was made — agent failed before calling forward-to-agent'"
                className="w-full border border-[#E5E5E5] rounded-xl px-4 py-3 text-[13px] text-[#111] resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10" />
            </div>

            {/* Prompt section at fault */}
            {diagnosis.prompt_section_at_fault && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-red-400 mb-2">Prompt Section at Fault</div>
                <p className="text-[12.5px] text-red-800 font-mono leading-relaxed whitespace-pre-wrap">{diagnosis.prompt_section_at_fault}</p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setStep("input")}
              className="flex items-center gap-1.5 px-4 py-3 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl hover:border-[#ADADAD] transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <button onClick={handleConfirmIssue} disabled={!config.bearerToken}
              className="flex-1 flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
              <CheckCircle className="w-4 h-4" />
              Confirmed — reproduce this issue
            </button>
          </div>
          {!config.bearerToken && <p className="text-[12px] text-red-500 mt-2">Bearer token required in sidebar.</p>}
        </div>
      )}

      {/* ══════════════════ STEP 3: REPRODUCE (live stream) ══════════════════ */}
      {step === "reproducing" && diagnosis && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-[15px] font-bold text-[#111]">
                Reproduction run {totalRuns + (isStreaming ? 1 : 0)}
                {totalRuns > 0 && <span className="text-[13px] font-normal text-[#888] ml-2">of {MAX_REPRO_RUNS} max</span>}
              </div>
              <div className="text-[12.5px] text-[#888] mt-0.5">Following the same conversation pattern as the escalation</div>
            </div>
            {/* Reproduced / Not badge (shown once at least 1 run done) */}
            {totalRuns > 0 && (
              <div className={clsx(
                "px-3 py-1.5 rounded-full text-[12px] font-bold",
                reproducedCount > 0 ? "bg-red-50 text-red-600 border border-red-200" : "bg-green-50 text-green-600 border border-green-200",
              )}>
                {reproducedCount > 0 ? `🐛 Reproduced ${reproducedCount}/${totalRuns}` : `✓ Not reproduced (${totalRuns} run${totalRuns > 1 ? "s" : ""})`}
              </div>
            )}
          </div>

          {/* Repro scenario info */}
          <div className="bg-[#FAFAF8] border border-[#EAEAEA] rounded-xl p-4 mb-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-2">Repro Scenario</div>
            <div className="text-[13px] text-[#222] mb-1"><strong>Opener:</strong> {diagnosis.repro_opener}</div>
            {diagnosis.repro_followups?.map((f, i) => (
              <div key={i} className="text-[13px] text-[#555] ml-4">↳ {f}</div>
            ))}
          </div>

          {/* Past runs summary */}
          {reproRuns.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {reproRuns.map(r => (
                <div key={r.id} className={clsx(
                  "px-2.5 py-1 rounded-full text-[11px] font-semibold",
                  r.result.reproduced ? "bg-red-50 text-red-600 border border-red-200" : "bg-green-50 text-green-600 border border-green-200",
                )}>
                  Run {r.id}: {r.result.reproduced ? "Bug seen" : "Passed"}
                </div>
              ))}
            </div>
          )}

          {/* Live stream */}
          {isStreaming && (
            <div className="mb-4">
              <LiveChat
                key={streamKey}
                params={{
                  repro_opener: diagnosis.repro_opener,
                  root_cause: editedRootCause || diagnosis.root_cause,
                  prescribed_followups: diagnosis.repro_followups ?? [],
                  api_base: config.apiBase,
                  bearer_token: config.bearerToken,
                  agent_phone: config.agentPhone,
                  openai_key: config.openaiKey,
                }}
                onDone={handleRunDone}
                onError={msg => { setError(msg); setCurrentRunId(0); }}
              />
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button onClick={() => { setReproRuns([]); setStep("confirm_issue"); }}
              className="flex items-center gap-1.5 px-4 py-3 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl hover:border-[#ADADAD] transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>

            {canTryMore && (
              <button onClick={handleTryAnotherRun}
                className="flex items-center gap-2 px-5 py-3 text-[13px] font-semibold text-brand-500 border border-brand-500 rounded-xl hover:bg-brand-500/5 transition-colors">
                <RefreshCw className="w-3.5 h-3.5" />
                Try again ({MAX_REPRO_RUNS - totalRuns} left)
              </button>
            )}

            {!isStreaming && totalRuns > 0 && (
              <button onClick={handleProceedToFix}
                disabled={!systemPrompt.trim() || !diagnosis.suggested_fix}
                className="flex-1 flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
                <ChevronRight className="w-4 h-4" />
                Review proposed fix
              </button>
            )}
          </div>
          {!systemPrompt.trim() && totalRuns > 0 && !isStreaming && (
            <p className="text-[12px] text-[#888] mt-2">Retell prompt not loaded — go back to Step 1 and refresh.</p>
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

            <div className="grid grid-cols-2 gap-5 mb-5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-red-400 mb-2">Before (at fault)</div>
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 font-mono text-[12.5px] text-red-800 leading-relaxed whitespace-pre-wrap min-h-[80px]">
                  {diagnosis.prompt_section_at_fault || "No specific section — fix will be appended."}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-green-600 mb-2">After (proposed)</div>
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 font-mono text-[12.5px] text-green-800 leading-relaxed whitespace-pre-wrap min-h-[80px]">
                  {diagnosis.suggested_fix}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setStep("reproducing")}
              className="flex items-center gap-1.5 px-4 py-3 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl hover:border-[#ADADAD] transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <button onClick={handleApplyFix}
              className="flex-1 flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors shadow-sm">
              <CheckCircle className="w-4 h-4" />
              Apply fix &amp; run full regression
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════ LOADING: applying / regression ══════════════════ */}
      {step === "applying_fix" && <LoadingCard title="Applying fix…" subtitle="Updating the prompt and preparing to run all 8 regression scenarios" />}
      {step === "regression" && <LoadingCard title="Running full regression…" subtitle="Testing all 8 scenarios in parallel — this takes ~2 minutes" />}

      {/* ══════════════════ STEP 5 / DONE ══════════════════ */}
      {step === "done" && regressionSummary && (
        <div>
          {/* Summary */}
          <div className="bg-white border border-[#EAEAEA] rounded-2xl p-6 mb-5 shadow-sm">
            <div className="flex items-center gap-4 mb-5">
              <div className={clsx(
                "w-16 h-16 rounded-2xl flex flex-col items-center justify-center flex-shrink-0",
                regressionSummary.pass_rate >= 90 ? "bg-green-50" : regressionSummary.pass_rate >= 70 ? "bg-yellow-50" : "bg-red-50",
              )}>
                <span className={clsx("text-[22px] font-extrabold leading-none",
                  regressionSummary.pass_rate >= 90 ? "text-green-600" : regressionSummary.pass_rate >= 70 ? "text-yellow-600" : "text-red-600",
                )}>{regressionSummary.pass_rate}%</span>
                <span className="text-[10px] text-[#ADADAD] mt-0.5">pass rate</span>
              </div>
              <div>
                <div className="text-[16px] font-bold text-[#111]">
                  {regressionSummary.pass_rate >= 90 ? "Regression passed ✓" : regressionSummary.pass_rate >= 70 ? "Regression partially passed" : "Regression needs attention"}
                </div>
                <div className="text-[13px] text-[#888] mt-1">
                  {regressionSummary.passed}/{regressionSummary.total} scenarios passed · avg score {regressionSummary.avg_score}/100
                </div>
              </div>
            </div>

            {/* Modified prompt */}
            <details className="border-t border-[#EAEAEA] pt-4 mb-3">
              <summary className="cursor-pointer text-[13px] font-semibold text-brand-500 select-none">
                Updated prompt ({appliedInline ? "applied inline" : "appended"})
              </summary>
              <pre className="mt-3 bg-[#F8F8F6] border border-[#EAEAEA] rounded-xl p-4 text-[12px] text-[#444] overflow-auto max-h-52 whitespace-pre-wrap font-mono leading-relaxed">
                {modifiedPrompt}
              </pre>
              <button onClick={() => copy(modifiedPrompt, "modified")}
                className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-brand-500 hover:underline">
                {copied === "modified" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied === "modified" ? "Copied!" : "Copy updated prompt"}
              </button>
            </details>

            {/* Revert to original */}
            {originalPrompt && (
              <details className="border border-[#F0F0EE] rounded-xl overflow-hidden">
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold text-[#888] select-none hover:bg-[#FAFAF8]">
                  ↩ Revert to original prompt
                </summary>
                <div className="px-4 pb-4">
                  <pre className="mt-3 bg-red-50 border border-red-100 rounded-xl p-4 text-[12px] text-red-800 overflow-auto max-h-40 whitespace-pre-wrap font-mono leading-relaxed">
                    {originalPrompt}
                  </pre>
                  <button onClick={() => copy(originalPrompt, "original")}
                    className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-[#888] hover:underline">
                    {copied === "original" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied === "original" ? "Copied!" : "Copy original prompt"}
                  </button>
                </div>
              </details>
            )}
          </div>

          {/* Individual results */}
          {regressionResults.length > 0 && (
            <div className="space-y-3 mb-5">
              {regressionResults.map((r, i) => <SimResultCard key={i} result={r} defaultExpanded={false} />)}
            </div>
          )}

          <button onClick={handleReset}
            className="flex items-center gap-2 text-[13px] font-semibold text-[#888] bg-white border border-[#E5E5E5] rounded-xl px-5 py-2.5 hover:border-brand-500 hover:text-brand-500 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
            Debug another escalation
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─── */
function LoadingCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl p-12 flex flex-col items-center justify-center text-center shadow-sm">
      <div className="w-10 h-10 border-[3px] border-brand-500 border-t-transparent rounded-full animate-spin mb-5" />
      <div className="text-[15px] font-bold text-[#111] mb-1.5">{title}</div>
      <div className="text-[13px] text-[#888] max-w-xs leading-relaxed">{subtitle}</div>
    </div>
  );
}
