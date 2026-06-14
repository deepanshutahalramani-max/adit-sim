import type { Config } from "../types";
import type { LucideIcon } from "lucide-react";
import { Phone, ChevronDown } from "lucide-react";
import { useState } from "react";

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  sub: string;
}

interface Props {
  config: Config;
  onChange: (c: Config) => void;
  agentName?: string;
  nav: readonly NavItem[];
  activeTab: string;
  onNavigate: (id: string) => void;
}

const HOSTS: Record<string, string> = {
  live:   "https://frontdeskchatagent.adit.com",
  beta:   "https://betafrontdeskchatagent.adit.com",
  custom: "https://frontdeskchatagent.adit.com",
};

const ENVS = [
  { id: "live",   label: "Production", dot: "bg-[#22C55E]" },
  { id: "beta",   label: "Beta",       dot: "bg-[#F59E0B]" },
  { id: "custom", label: "Custom",     dot: "bg-[#7C3AED]" },
];

export function Sidebar({ config, onChange, agentName = "—", nav, activeTab, onNavigate }: Props) {
  const [envOpen, setEnvOpen] = useState(false);
  const set = (k: keyof Config, v: unknown) => onChange({ ...config, [k]: v });
  const activeEnv = ENVS.find(e => e.id === config.environment) ?? ENVS[0];

  const switchEnv = (id: string) => {
    localStorage.setItem("adit_env", id);
    onChange({
      ...config,
      environment: id,
      apiBase: HOSTS[id] ?? HOSTS.live,
      smsAgentId: undefined,
      callAgentId: undefined,
    });
    setEnvOpen(false);
  };

  return (
    <aside className="w-[248px] bg-canvas-raised border-r border-line flex flex-col flex-shrink-0">
      {/* Brand */}
      <div className="px-5 h-[68px] flex items-center gap-3 border-b border-line">
        <div className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 bg-brand-500 shadow-brand">
          <img src="/adit-logo.svg" alt="ADIT" className="w-9 h-9 object-contain"
            onError={e => {
              const t = e.currentTarget; t.onerror = null; t.style.display = "none";
              (t.parentElement as HTMLElement).innerHTML =
                '<span class="text-white font-extrabold text-[18px]">a</span>';
            }}
          />
        </div>
        <div className="min-w-0">
          <div className="text-[14.5px] font-extrabold text-ink-900 leading-tight">Agent QA</div>
          <div className="text-[11px] text-ink-400 leading-tight">AI Front Desk</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="section-label px-3 mb-2">Workspace</div>
        {nav.map(item => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left relative ${
                active
                  ? "bg-brand-50 text-brand-700"
                  : "text-ink-500 hover:bg-canvas-sunken hover:text-ink-900"
              }`}
            >
              {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-brand-500" />}
              <Icon className={`w-[18px] h-[18px] flex-shrink-0 ${active ? "text-brand-500" : "text-ink-400 group-hover:text-ink-700"}`} strokeWidth={2.2} />
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold leading-tight">{item.label}</div>
              </div>
            </button>
          );
        })}
      </nav>

      {/* Real-phone notice */}
      <div className="px-3">
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-brand-50/60 border border-brand-100">
          <Phone className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
          <div className="text-[11px] text-brand-800 leading-snug">
            Real calls & SMS — every test hits the practice line and shows in the ADIT app.
          </div>
        </div>
      </div>

      {/* Environment switcher */}
      <div className="p-3 relative">
        {envOpen && (
          <div className="absolute bottom-[calc(100%-4px)] left-3 right-3 card shadow-pop p-1.5 animate-scale-in z-20">
            {ENVS.map(e => (
              <button key={e.id} onClick={() => switchEnv(e.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                  e.id === config.environment ? "bg-canvas-sunken text-ink-900" : "text-ink-500 hover:bg-canvas-sunken"
                }`}>
                <span className={`w-2 h-2 rounded-full ${e.dot}`} />
                {e.label}
                {e.id === config.environment && <span className="ml-auto text-brand-500 text-[11px] font-bold">●</span>}
              </button>
            ))}
          </div>
        )}
        <button onClick={() => setEnvOpen(o => !o)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-line-strong hover:border-ink-300 bg-white transition-colors">
          <span className={`w-2 h-2 rounded-full ${activeEnv.dot}`} />
          <div className="text-left min-w-0">
            <div className="text-[10px] text-ink-400 uppercase tracking-wide font-bold leading-none">Environment</div>
            <div className="text-[13px] font-semibold text-ink-900 leading-tight mt-0.5">{activeEnv.label}</div>
          </div>
          <ChevronDown className={`w-4 h-4 text-ink-400 ml-auto transition-transform ${envOpen ? "rotate-180" : ""}`} />
        </button>

        {/* Custom destination number (Custom env only) */}
        {config.environment === "custom" && (
          <div className="mt-2">
            <div className="text-[10px] text-ink-400 uppercase tracking-wide font-bold mb-1">Number to call / text</div>
            <input
              value={config.customNumber ?? ""}
              onChange={e => {
                const v = e.target.value;
                localStorage.setItem("adit_custom_number", v);
                set("customNumber", v);
              }}
              placeholder="+1 555 123 4567"
              className="w-full bg-white border border-line-strong rounded-lg px-3 py-2 text-[13px] font-mono
                         focus:outline-none focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10"
            />
            <p className="text-[10.5px] text-ink-400 mt-1 leading-snug">
              The platform will call / text this number directly. Use E.164 (e.g. +14025031303).
            </p>
          </div>
        )}

        {/* Judge toggle */}
        <button onClick={() => set("useLlmJudge", !config.useLlmJudge)}
          className="w-full flex items-center justify-between px-3 py-2.5 mt-2 rounded-xl hover:bg-canvas-sunken transition-colors">
          <span className="text-[12.5px] text-ink-500 font-medium">LLM Judge scoring</span>
          <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${config.useLlmJudge ? "bg-brand-500" : "bg-line-strong"}`}>
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${config.useLlmJudge ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
          </span>
        </button>
      </div>
    </aside>
  );
}
