import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Config } from "../types";

interface Props {
  config: Config;
  onChange: (c: Config) => void;
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

function SideInput({
  label, value, onChange, type = "text", placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const isPassword = type === "password";
  return (
    <div className="mb-4">
      <Label>{label}</Label>
      <div className="relative">
        <input
          type={isPassword && !show ? "password" : "text"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-[#F7F7F5] border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] text-[#111]
                     focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/10"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#ADADAD] hover:text-[#666]"
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

export function Sidebar({ config, onChange }: Props) {
  const set = (k: keyof Config, v: unknown) => {
    if (k === "openaiKey") localStorage.setItem("adit_openai_key", v as string);
    if (k === "bearerToken") localStorage.setItem("adit_bearer", v as string);
    onChange({ ...config, [k]: v });
  };

  return (
    <aside className="w-64 bg-white border-r border-[#EAEAEA] flex flex-col flex-shrink-0 overflow-y-auto">
      <div className="p-5 border-b border-[#F0F0EE]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-brand-500 rounded-lg flex items-center justify-center text-white font-extrabold text-base shadow-sm">
            a
          </div>
          <div>
            <div className="text-[14px] font-bold text-[#111] leading-tight">Agent QA</div>
            <div className="text-[11px] text-[#ADADAD]">AI Front Desk</div>
          </div>
        </div>
      </div>

      <div className="flex-1 p-5 space-y-0">
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
                       focus:outline-none focus:border-brand-500"
          >
            <option value="live">🟢 Live (frontdeskchatagent.adit.com)</option>
            <option value="dev">🔵 Dev (RunPod beta)</option>
          </select>
        </div>

        <SideInput
          label="Bearer Token"
          value={config.bearerToken}
          onChange={v => set("bearerToken", v)}
          type="password"
          placeholder="Paste bearer token…"
        />

        <SideInput
          label="Agent Phone"
          value={config.agentPhone}
          onChange={v => set("agentPhone", v)}
          placeholder="+12673565689"
        />

        <SideInput
          label="OpenAI API Key"
          value={config.openaiKey}
          onChange={v => set("openaiKey", v)}
          type="password"
          placeholder="sk-…"
        />

        <div className="mb-4">
          <Label>LLM Judge Scoring</Label>
          <button
            onClick={() => set("useLlmJudge", !config.useLlmJudge)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.useLlmJudge ? "bg-brand-500" : "bg-[#E5E5E5]"
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              config.useLlmJudge ? "translate-x-6" : "translate-x-1"
            }`} />
          </button>
        </div>

        <hr className="border-[#F0F0EE] my-4" />

        <div>
          <Label>Status</Label>
          <p className="text-[12px] text-[#ADADAD] mb-1">Agent · Siriyaa (Test QA)</p>
          <p className="text-[12px] text-[#ADADAD] mb-1">
            Phone ·{" "}
            <code className="bg-[#FFF3E8] text-[#D4620A] rounded px-1 py-0.5 text-[11.5px]">
              {config.agentPhone}
            </code>
          </p>
          <p className="text-[12px] text-[#ADADAD]">
            Env · {config.environment === "live" ? "Live Production" : "Dev / RunPod"}
          </p>
        </div>
      </div>
    </aside>
  );
}
