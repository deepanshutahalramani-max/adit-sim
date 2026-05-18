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
  label, value, onChange, type = "text", placeholder, savedFromStorage, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; savedFromStorage?: boolean; hint?: string;
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
        type={isSecret ? "password" : "text"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#F7F7F5] border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] text-[#111]
                   focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
      />
      {hint && <p className="text-[10.5px] text-[#ADADAD] mt-1">{hint}</p>}
      {isSecret && !hasValue && !hint && (
        <p className="text-[10.5px] text-[#ADADAD] mt-1">Enter once — saved automatically</p>
      )}
    </div>
  );
}

export function Sidebar({ config, onChange, agentName = "—" }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const stored = (key: string) => !!(localStorage.getItem(key));

  const set = (k: keyof Config, v: unknown) => {
    const map: Partial<Record<keyof Config, string>> = {
      openaiKey:    "adit_openai_key",
      bearerToken:  "adit_bearer",
      agentPhone:   "adit_agent_phone",
      smsAgentId:   "adit_sms_agent_id",
      callAgentId:  "adit_call_agent_id",
    };
    if (map[k]) localStorage.setItem(map[k]!, v as string);
    onChange({ ...config, [k]: v });
  };

  const allGood = !!config.bearerToken && !!config.openaiKey
    && !!config.smsAgentId && !!config.callAgentId;

  return (
    <aside className="w-64 bg-white border-r border-[#EAEAEA] flex flex-col flex-shrink-0 overflow-y-auto">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-[#F0F0EE]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0">
            <img src="/adit-logo.svg" alt="ADIT" className="w-8 h-8 object-contain"
              onError={e => {
                const t = e.currentTarget;
                t.onerror = null; t.style.display = "none";
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
        {/* Warning */}
        {!allGood && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
            <p className="text-[11px] font-semibold text-amber-700">
              {!config.bearerToken
                ? "Bearer token required"
                : !config.smsAgentId || !config.callAgentId
                  ? "Paste both Retell Agent IDs to get started"
                  : "OpenAI key required for AI features"}
            </p>
          </div>
        )}

        {/* ── Core credentials ── */}
        <SideInput
          label="Bearer Token"
          value={config.bearerToken}
          onChange={v => set("bearerToken", v)}
          type="password"
          placeholder="Paste bearer token…"
          savedFromStorage={stored("adit_bearer")}
        />

        <hr className="border-[#F0F0EE] my-3" />
        <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-3">
          Retell Agents
          <span className="normal-case font-normal ml-1 text-[#ADADAD]">— copy IDs from dashboard</span>
        </div>

        <SideInput
          label="SMS Agent ID"
          value={config.smsAgentId ?? ""}
          onChange={v => set("smsAgentId", v || undefined)}
          placeholder="agent_ee5d…"
          savedFromStorage={stored("adit_sms_agent_id")}
          hint="Chat / inbound SMS agent"
        />

        <SideInput
          label="Call Agent ID"
          value={config.callAgentId ?? ""}
          onChange={v => set("callAgentId", v || undefined)}
          placeholder="agent_8c76…"
          savedFromStorage={stored("adit_call_agent_id")}
          hint="Voice / inbound call agent"
        />

        <hr className="border-[#F0F0EE] my-3" />

        <SideInput
          label="OpenAI API Key"
          value={config.openaiKey}
          onChange={v => set("openaiKey", v)}
          type="password"
          placeholder="sk-proj-…"
          savedFromStorage={stored("adit_openai_key")}
        />

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

        {/* ── Advanced ── */}
        <div className="mb-4">
          <button
            onClick={() => setAdvancedOpen(o => !o)}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] hover:text-[#888] transition-colors w-full text-left"
          >
            {advancedOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Advanced
          </button>

          {advancedOpen && (
            <div className="mt-3 border border-[#F0F0EE] rounded-lg p-3 bg-[#FAFAF8] space-y-3">
              {/* Environment */}
              <div>
                <Label>Environment</Label>
                <select
                  value={config.environment}
                  onChange={e => {
                    const env = e.target.value;
                    set("environment", env);
                    set("apiBase", HOSTS[env] ?? HOSTS.live);
                  }}
                  className="w-full bg-white border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] text-[#111]
                             focus:outline-none focus:border-brand-500 truncate"
                >
                  <option value="live">🟢 Live</option>
                  <option value="dev">🔵 Dev (RunPod)</option>
                </select>
                <p className="text-[10.5px] text-[#ADADAD] mt-1 truncate">{config.apiBase}</p>
              </div>

              {/* Agent Phone — still needed for ADIT SMS routing */}
              <SideInput
                label="ADIT Practice Phone"
                value={config.agentPhone}
                onChange={v => set("agentPhone", v)}
                placeholder="+12673565689"
                savedFromStorage={stored("adit_agent_phone")}
                hint="Routes SMS simulations to the right practice"
              />
            </div>
          )}
        </div>

        <hr className="border-[#F0F0EE] my-4" />

        {/* Status */}
        <div>
          <Label>Status</Label>
          <div className="space-y-1.5">
            <StatusRow
              ok={!!config.bearerToken}
              label="Bearer token"
              value={config.bearerToken ? "Set" : "Missing"}
              valueClass={config.bearerToken ? "text-green-600" : "text-[#ADADAD]"}
            />
            <StatusRow
              ok={!!config.openaiKey}
              okColor={config.openaiKey ? "bg-green-500" : "bg-amber-400"}
              label="OpenAI key"
              value={config.openaiKey ? "Set" : "Missing"}
              valueClass={config.openaiKey ? "text-green-600" : "text-amber-600"}
            />
            <StatusRow
              ok={!!config.smsAgentId}
              label="SMS agent"
              value={config.smsAgentId
                ? <code className="text-[10px] font-mono text-[#D4620A] bg-[#FFF3E8] rounded px-1">{config.smsAgentId.slice(0, 12)}…</code>
                : <span className="text-[#ADADAD]">Not set</span>}
            />
            <StatusRow
              ok={!!config.callAgentId}
              label="Call agent"
              value={config.callAgentId
                ? <code className="text-[10px] font-mono text-[#D4620A] bg-[#FFF3E8] rounded px-1">{config.callAgentId.slice(0, 12)}…</code>
                : <span className="text-[#ADADAD]">Not set</span>}
            />
            {agentName !== "—" && (
              <StatusRow ok label="Name" value={agentName} valueClass="text-[#555]" />
            )}
            <StatusRow
              ok={config.environment === "live"}
              okColor={config.environment === "live" ? "bg-green-500" : "bg-blue-400"}
              label="Env"
              value={config.environment === "live" ? "Production" : "Dev"}
              valueClass="text-[#555]"
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

function StatusRow({ ok, okColor, label, value, valueClass }: {
  ok: boolean; okColor?: string; label: string;
  value: React.ReactNode; valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${okColor ?? (ok ? "bg-green-500" : "bg-[#DADAD8]")}`} />
      <span className="text-[12px] text-[#666]">{label}</span>
      <span className={`text-[11px] font-semibold ml-auto ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}
