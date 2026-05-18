import { useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { Config } from "../types";

interface Props {
  config: Config;
  onChange: (c: Config) => void;
  agentName?: string;
}

const HOSTS: Record<string, string> = {
  live: "https://frontdeskchatagent.adit.com",
  dev:  "https://gjqwwdfeo35edl-8009.proxy.runpod.net",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">
      {children}
    </div>
  );
}

function SavedBadge({ saved }: { saved: boolean }) {
  if (!saved) return null;
  return (
    <span className="flex items-center gap-0.5 text-[10px] font-semibold text-green-600">
      <Check className="w-2.5 h-2.5" /> Saved
    </span>
  );
}

function SideInput({
  label, value, onChange, type = "text", placeholder, savedFromStorage,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; savedFromStorage?: boolean;
}) {
  const isSecret = type === "password";
  const hasValue = value.length > 0;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <Label>{label}</Label>
        {isSecret && <SavedBadge saved={!!savedFromStorage && hasValue} />}
      </div>
      <input
        /* Always keep secrets masked — no show/hide toggle so values are never
           visible to anyone looking at the screen. */
        type={isSecret ? "password" : "text"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#F7F7F5] border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] text-[#111]
                   focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
      />
      {isSecret && !hasValue && (
        <p className="text-[10.5px] text-[#ADADAD] mt-1">Enter once — saved automatically</p>
      )}
    </div>
  );
}

export function Sidebar({ config, onChange, agentName = "—" }: Props) {
  const [agentIdsOpen, setAgentIdsOpen] = useState(
    !!(config.smsAgentId || config.callAgentId)
  );

  // Track which keys came from localStorage (already persisted)
  const bearerFromStorage   = !!(localStorage.getItem("adit_bearer"));
  const openaiFromStorage   = !!(localStorage.getItem("adit_openai_key"));
  const phoneFromStorage    = !!(localStorage.getItem("adit_agent_phone"));
  const smsAgentFromStorage = !!(localStorage.getItem("adit_sms_agent_id"));
  const callAgentFromStorage= !!(localStorage.getItem("adit_call_agent_id"));

  const set = (k: keyof Config, v: unknown) => {
    if (k === "openaiKey")    localStorage.setItem("adit_openai_key",    v as string);
    if (k === "bearerToken")  localStorage.setItem("adit_bearer",        v as string);
    if (k === "agentPhone")   localStorage.setItem("adit_agent_phone",   v as string);
    if (k === "smsAgentId")   localStorage.setItem("adit_sms_agent_id",  v as string);
    if (k === "callAgentId")  localStorage.setItem("adit_call_agent_id", v as string);
    onChange({ ...config, [k]: v });
  };

  const allGood = !!config.bearerToken && !!config.openaiKey;

  return (
    <aside className="w-64 bg-white border-r border-[#EAEAEA] flex flex-col flex-shrink-0 overflow-y-auto">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-[#F0F0EE]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0">
            <img src="/adit-logo.svg" alt="ADIT" className="w-8 h-8 object-contain"
              onError={e => {
                const t = e.currentTarget;
                t.onerror = null;
                t.style.display = "none";
                (t.parentElement as HTMLElement).innerHTML =
                  '<div class="w-8 h-8 bg-brand-500 rounded-lg flex items-center justify-center text-white font-extrabold text-base shadow-sm">a</div>';
              }}
            />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-bold text-[#111] leading-tight">Agent QA</div>
            <div className="text-[11px] text-[#ADADAD]">AI Front Desk</div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-4 overflow-y-auto">
        {/* Missing keys warning */}
        {!allGood && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
            <p className="text-[11px] font-semibold text-amber-700">
              {!config.bearerToken && !config.openaiKey
                ? "Enter bearer token + OpenAI key to run simulations"
                : !config.bearerToken
                  ? "Bearer token required to run simulations"
                  : "OpenAI key required for AI judge & patient simulation"}
            </p>
          </div>
        )}

        {/* Environment */}
        <div className="mb-4">
          <Label>Environment</Label>
          <select
            value={config.environment}
            onChange={e => {
              const env = e.target.value;
              set("environment", env);
              set("apiBase", HOSTS[env] ?? HOSTS.live);
            }}
            className="w-full bg-[#F7F7F5] border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] text-[#111]
                       focus:outline-none focus:border-brand-500 truncate"
          >
            <option value="live">🟢 Live</option>
            <option value="dev">🔵 Dev (RunPod)</option>
          </select>
          <p className="text-[10.5px] text-[#ADADAD] mt-1 truncate">{config.apiBase}</p>
        </div>

        <SideInput
          label="Bearer Token"
          value={config.bearerToken}
          onChange={v => set("bearerToken", v)}
          type="password"
          placeholder="Paste bearer token…"
          savedFromStorage={bearerFromStorage}
        />

        <SideInput
          label="Agent Phone"
          value={config.agentPhone}
          onChange={v => set("agentPhone", v)}
          placeholder="+12673565689"
          savedFromStorage={phoneFromStorage}
        />

        <SideInput
          label="OpenAI API Key"
          value={config.openaiKey}
          onChange={v => set("openaiKey", v)}
          type="password"
          placeholder="sk-proj-…"
          savedFromStorage={openaiFromStorage}
        />

        {/* ── Advanced: explicit Retell Agent IDs ── */}
        <div className="mb-4">
          <button
            onClick={() => setAgentIdsOpen(o => !o)}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] hover:text-[#888] transition-colors w-full text-left mb-1.5"
          >
            {agentIdsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Agent IDs <span className="normal-case font-normal text-[#ADADAD] ml-1">(optional)</span>
          </button>
          {agentIdsOpen && (
            <div className="border border-[#F0F0EE] rounded-lg p-3 space-y-3 bg-[#FAFAF8]">
              <div className="text-[10px] text-[#ADADAD] leading-relaxed">
                Paste Retell agent IDs to lock the prompt to a specific agent. Overrides phone-based lookup. Copy from Retell dashboard.
              </div>
              <SideInput
                label="SMS Agent ID"
                value={config.smsAgentId ?? ""}
                onChange={v => set("smsAgentId", v)}
                placeholder="agent_ee5d…"
                savedFromStorage={smsAgentFromStorage}
              />
              <SideInput
                label="Call Agent ID"
                value={config.callAgentId ?? ""}
                onChange={v => set("callAgentId", v)}
                placeholder="agent_8c76…"
                savedFromStorage={callAgentFromStorage}
              />
            </div>
          )}
        </div>

        {/* LLM Judge toggle */}
        <div className="mb-4">
          <Label>LLM Judge Scoring</Label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => set("useLlmJudge", !config.useLlmJudge)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                config.useLlmJudge ? "bg-brand-500" : "bg-[#E5E5E5]"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                config.useLlmJudge ? "translate-x-6" : "translate-x-1"
              }`} />
            </button>
            <span className="text-[12px] text-[#888]">{config.useLlmJudge ? "On" : "Off"}</span>
          </div>
        </div>

        <hr className="border-[#F0F0EE] my-4" />

        {/* Status */}
        <div>
          <Label>Status</Label>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${config.bearerToken ? "bg-green-500" : "bg-[#DADAD8]"}`} />
              <span className="text-[12px] text-[#666]">Bearer token</span>
              <span className={`text-[11px] font-semibold ml-auto ${config.bearerToken ? "text-green-600" : "text-[#ADADAD]"}`}>
                {config.bearerToken ? "Set" : "Missing"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${config.openaiKey ? "bg-green-500" : "bg-amber-400"}`} />
              <span className="text-[12px] text-[#666]">OpenAI key</span>
              <span className={`text-[11px] font-semibold ml-auto ${config.openaiKey ? "text-green-600" : "text-amber-600"}`}>
                {config.openaiKey ? "Set" : "Missing"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-green-500" />
              <span className="text-[12px] text-[#666]">Agent</span>
              <span className="text-[11px] font-semibold ml-auto text-[#555]">{agentName}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-green-500" />
              <span className="text-[12px] text-[#666]">Phone</span>
              <code className="text-[10.5px] font-mono text-[#D4620A] bg-[#FFF3E8] rounded px-1 ml-auto">{config.agentPhone}</code>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${config.environment === "live" ? "bg-green-500" : "bg-blue-400"}`} />
              <span className="text-[12px] text-[#666]">Env</span>
              <span className="text-[11px] font-semibold ml-auto text-[#555]">
                {config.environment === "live" ? "Production" : "Dev"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
