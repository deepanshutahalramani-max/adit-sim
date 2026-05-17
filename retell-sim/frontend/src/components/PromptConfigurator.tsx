/**
 * PromptConfigurator — Fetches the live Retell template, lets you toggle 4
 * behavioural flags, and streams the resolved prompt back via `onLoad`.
 */
import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { fetchRetellPrompt, fetchRetellCallPrompt, resolvePrompt, type PromptToggles } from "../api";

interface Props {
  /** Called whenever the resolved prompt changes (initial load + every toggle). */
  onLoad: (prompt: string) => void;
  /** "chat" fetches the SMS/chat agent prompt; "call" fetches the voice call agent prompt. */
  agentType?: "chat" | "call";
  /** Extra class names for the outer wrapper. */
  className?: string;
}

const DEFAULT_TOGGLES: PromptToggles = {
  schedule_new:      true,
  schedule_existing: true,
  rescheduling:      true,
  cancellation:      true,
};

const TOGGLE_ROWS: { key: keyof PromptToggles; label: string; emoji: string }[] = [
  { key: "schedule_new",      label: "New Patient Scheduling",      emoji: "🆕" },
  { key: "schedule_existing", label: "Existing Patient Scheduling", emoji: "👤" },
  { key: "rescheduling",      label: "Rescheduling",                emoji: "🔄" },
  { key: "cancellation",      label: "Cancellation",                emoji: "❌" },
];

export function PromptConfigurator({ onLoad, agentType = "chat", className = "" }: Props) {
  const [template, setTemplate]           = useState("");   // raw Retell template ({{placeholders}})
  const [resolvedPrompt, setResolvedPrompt] = useState(""); // substituted output — shown in textarea
  const [toggles, setToggles]             = useState<PromptToggles>(DEFAULT_TOGGLES);
  const [loading, setLoading]             = useState(true);
  const [resolving, setResolving]         = useState(false);
  const [error, setError]                 = useState("");

  /* ─── Resolve template → update textarea + call onLoad ─── */
  const resolve = useCallback(async (tmpl: string, flags: PromptToggles) => {
    if (!tmpl.trim()) return;
    setResolving(true);
    try {
      const { prompt } = await resolvePrompt({ template: tmpl, ...flags });
      setResolvedPrompt(prompt);  // ← update the visible textarea
      onLoad(prompt);
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : "Failed to resolve prompt"));
    } finally {
      setResolving(false);
    }
  }, [onLoad]);

  /* ─── Fetch live Retell template ─── */
  const fetchTemplate = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const fetcher = agentType === "call" ? fetchRetellCallPrompt : fetchRetellPrompt;
      const { prompt } = await fetcher();
      setTemplate(prompt);
      await resolve(prompt, toggles);
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : "Failed to fetch Retell prompt"));
    } finally {
      setLoading(false);
    }
  // agentType is stable per mount — component is always remounted when mode changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType]);

  useEffect(() => { fetchTemplate(); }, [fetchTemplate]);

  /* ─── Toggle handler — re-resolves from raw template so substitution reflects new flag ─── */
  const handleToggle = (key: keyof PromptToggles) => {
    const next = { ...toggles, [key]: !toggles[key] };
    setToggles(next);
    resolve(template, next);  // always re-resolve from the raw template
  };

  /* ─── Manual textarea edit — user is editing the resolved output directly ─── */
  const handleResolvedEdit = (val: string) => {
    setResolvedPrompt(val);
    onLoad(val);  // bypass resolve — pass edit straight through
  };

  return (
    <div className={className}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD]">
          Retell System Prompt
        </span>
        <button
          onClick={fetchTemplate}
          disabled={loading || resolving}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-500 hover:text-brand-600 disabled:opacity-40 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${(loading || resolving) ? "animate-spin" : ""}`} />
          {loading ? "Fetching…" : "Refresh from Retell"}
        </button>
      </div>

      {/* Amber warning on fetch error — still show textarea below for manual paste */}
      {error && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
          {error.includes("custom-llm") || error.includes("ADIT backend")
            ? "ℹ️ SMS agent uses a custom LLM — the prompt is stored in ADIT, not Retell. Paste it manually below."
            : "⚠ Could not auto-fetch prompt — paste it manually below."
          }
          <span className="block text-[10px] text-amber-600 mt-0.5 font-mono">{error}</span>
        </div>
      )}

      {/* Toggle rows */}
      <div className="flex flex-wrap gap-2 mb-2">
        {TOGGLE_ROWS.map(({ key, label, emoji }) => {
          const isOn = toggles[key];
          return (
            <button
              key={key}
              onClick={() => handleToggle(key)}
              disabled={loading || resolving}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors disabled:opacity-40 ${
                isOn
                  ? "bg-brand-500 text-white border-brand-500"
                  : "bg-white text-[#888] border-[#E5E5E5] hover:border-[#ADADAD]"
              }`}
            >
              <span>{emoji}</span>
              <span>{label}</span>
              <span className={`ml-0.5 text-[10px] font-bold ${isOn ? "text-white/70" : "text-[#ADADAD]"}`}>
                {isOn ? "ON" : "OFF"}
              </span>
            </button>
          );
        })}
        {resolving && <RefreshCw className="w-3.5 h-3.5 text-brand-500 animate-spin self-center" />}
      </div>

      <div className="text-[10.5px] text-[#ADADAD] mb-1">
        {loading
          ? "Loading live Retell template…"
          : "Resolved prompt — toggling capabilities updates it live. Edit manually if needed."}
      </div>

      {/* Textarea shows the RESOLVED prompt (placeholders substituted).
          Toggling a flag re-resolves and updates this. Manual edits bypass resolve. */}
      <textarea
        value={resolvedPrompt}
        onChange={e => handleResolvedEdit(e.target.value)}
        placeholder={loading ? "Loading…" : "Paste the Retell system prompt here…"}
        rows={8}
        className="w-full text-[11px] font-mono border border-[#E5E5E5] rounded-lg px-3 py-2 resize-y bg-white text-[#333] focus:outline-none focus:ring-1 focus:ring-brand-400 disabled:opacity-50"
        disabled={loading}
      />
    </div>
  );
}
