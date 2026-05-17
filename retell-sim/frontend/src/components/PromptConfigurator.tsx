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
  const [template, setTemplate]       = useState("");
  const [toggles, setToggles]         = useState<PromptToggles>(DEFAULT_TOGGLES);
  const [loading, setLoading]         = useState(true);
  const [resolving, setResolving]     = useState(false);
  const [error, setError]             = useState("");

  /* ─── Resolve template → call onLoad ─── */
  const resolve = useCallback(async (tmpl: string, flags: PromptToggles) => {
    if (!tmpl) return;
    setResolving(true);
    try {
      const { prompt } = await resolvePrompt({ template: tmpl, ...flags });
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

  /* ─── Toggle handler ─── */
  const handleToggle = (key: keyof PromptToggles) => {
    const next = { ...toggles, [key]: !toggles[key] };
    setToggles(next);
    resolve(template, next);
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

      {error && (
        <div className="text-[11px] text-red-500 mb-2">⚠ {error} — paste template manually if needed</div>
      )}

      {/* Toggle rows */}
      <div className="flex flex-wrap gap-2 mb-2">
        {TOGGLE_ROWS.map(({ key, label, emoji }) => {
          const isOn = toggles[key];
          return (
            <button
              key={key}
              onClick={() => handleToggle(key)}
              disabled={loading}
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
          : "Toggle capabilities above — prompt updates automatically. Edit manually if needed."}
      </div>
    </div>
  );
}
