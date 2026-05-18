/**
 * PromptConfigurator — Fetches the live Retell template, lets you toggle 4
 * behavioural flags, and streams the resolved prompt back via `onLoad`.
 *
 * Phone changes are debounced (800ms) so a fetch isn't triggered on every keystroke.
 */
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchRetellPrompt, fetchRetellCallPrompt, resolvePrompt, type PromptToggles } from "../api";

interface Props {
  /** Called whenever the resolved prompt changes (initial load + every toggle). */
  onLoad?: (prompt: string) => void;
  /** "chat" fetches the SMS/chat agent prompt; "call" fetches the voice call agent prompt. */
  agentType?: "chat" | "call";
  /**
   * Agent phone number from sidebar config. When provided, the backend will
   * look up the correct Retell agent for that phone number instead of using
   * the hardcoded default. Re-fetches automatically when changed (debounced 800ms).
   */
  agentPhone?: string;
  /** Explicit Retell agent ID — takes priority over phone lookup when set. */
  agentId?: string;
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

export function PromptConfigurator({ onLoad, agentType = "chat", agentPhone, agentId, className = "" }: Props) {
  const [template, setTemplate]             = useState("");
  const [resolvedPrompt, setResolvedPrompt] = useState("");
  const [toggles, setToggles]               = useState<PromptToggles>(DEFAULT_TOGGLES);
  const [loading, setLoading]               = useState(true);
  const [resolving, setResolving]           = useState(false);
  const [error, setError]                   = useState("");

  // Keep refs so async callbacks always see the latest values without stale closures
  const onLoadRef    = useRef(onLoad);
  const togglesRef   = useRef(toggles);
  const templateRef  = useRef(template);
  useEffect(() => { onLoadRef.current   = onLoad;   }, [onLoad]);
  useEffect(() => { togglesRef.current  = toggles;  }, [toggles]);
  useEffect(() => { templateRef.current = template; }, [template]);

  /* ─── Core: resolve a raw template with flags → update textarea + fire onLoad ─── */
  const resolve = async (tmpl: string, flags: PromptToggles) => {
    if (!tmpl.trim()) return;
    setResolving(true);
    try {
      const { prompt } = await resolvePrompt({ template: tmpl, ...flags });
      setResolvedPrompt(prompt);
      onLoadRef.current?.(prompt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resolve prompt");
    } finally {
      setResolving(false);
    }
  };

  /* ─── Fetch live Retell template then resolve it ─── */
  const doFetch = async (phone?: string) => {
    setLoading(true);
    setError("");
    try {
      const fetcher = agentType === "call" ? fetchRetellCallPrompt : fetchRetellPrompt;
      // Pass explicit agentId (highest priority) then phone for auto-lookup
      const { prompt } = await fetcher(phone, agentId);
      setTemplate(prompt);
      templateRef.current = prompt;
      await resolve(prompt, togglesRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch Retell prompt");
    } finally {
      setLoading(false);
    }
  };

  /* ─── Initial mount: fetch once for current agentType ─── */
  useEffect(() => {
    doFetch(agentPhone);
    // Only run on mount and agentType changes — agentPhone gets its own debounced effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType]);

  /* ─── Re-fetch when agentPhone or agentId changes, debounced 800ms ─── */
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    const timer = setTimeout(() => { doFetch(agentPhone); }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentPhone, agentId]);

  /* ─── Toggle handler ─── */
  const handleToggle = (key: keyof PromptToggles) => {
    const next = { ...toggles, [key]: !toggles[key] };
    setToggles(next);
    resolve(templateRef.current, next);
  };

  /* ─── Manual textarea edit ─── */
  const handleResolvedEdit = (val: string) => {
    setResolvedPrompt(val);
    onLoadRef.current?.(val);
  };

  return (
    <div className={className}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD]">
          Retell System Prompt
        </span>
        <button
          onClick={() => doFetch(agentPhone)}
          disabled={loading || resolving}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-500 hover:text-brand-600 disabled:opacity-40 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${(loading || resolving) ? "animate-spin" : ""}`} />
          {loading ? "Fetching…" : "Refresh from Retell"}
        </button>
      </div>

      {/* Amber warning on fetch error */}
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
