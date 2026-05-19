import type { Config } from "../types";

interface Props {
  config: Config;
  onChange: (c: Config) => void;
  agentName?: string;
}

const HOSTS: Record<string, string> = {
  live: "https://frontdeskchatagent.adit.com",
  beta: "https://betafrontdeskchatagent.adit.com",
  dev:  "https://gjqwwdfeo35edl-8009.proxy.runpod.net",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">
      {children}
    </div>
  );
}

export function Sidebar({ config, onChange, agentName = "—" }: Props) {
  const set = (k: keyof Config, v: unknown) => {
    onChange({ ...config, [k]: v });
  };

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

        {/* ── Environment selector (top-level, always visible) ── */}
        <div className="mb-4">
          <Label>Environment</Label>
          <select
            value={config.environment}
            onChange={e => {
              const newEnv = e.target.value;
              localStorage.setItem("adit_env", newEnv);
              onChange({
                ...config,
                environment: newEnv,
                apiBase:     HOSTS[newEnv] ?? HOSTS.live,
                // agent IDs will be refreshed by App.tsx useEffect on apiBase change
                smsAgentId:  undefined,
                callAgentId: undefined,
              });
            }}
            className="w-full bg-[#F7F7F5] border border-[#E5E5E5] rounded-lg px-3 py-2 text-[13px] text-[#111]
                       focus:outline-none focus:border-brand-500"
          >
            <option value="live">🟢 Live (PROD)</option>
            <option value="beta">🟡 Beta</option>
            <option value="dev">🔵 Dev (RunPod)</option>
          </select>
          <p className="text-[10.5px] text-[#ADADAD] mt-1 truncate">{config.apiBase}</p>
        </div>

        {/* ── LLM Judge toggle ── */}
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

        {/* ── Status panel ── */}
        <div>
          <Label>Status</Label>
          <div className="space-y-1.5">
            <StatusRow
              ok={!!config.smsAgentId}
              label="SMS agent"
              value={config.smsAgentId
                ? <code className="text-[10px] font-mono text-[#D4620A] bg-[#FFF3E8] rounded px-1">{config.smsAgentId.slice(0, 12)}…</code>
                : <span className="text-[#ADADAD]">Loading…</span>}
            />
            <StatusRow
              ok={!!config.callAgentId}
              label="Call agent"
              value={config.callAgentId
                ? <code className="text-[10px] font-mono text-[#D4620A] bg-[#FFF3E8] rounded px-1">{config.callAgentId.slice(0, 12)}…</code>
                : <span className="text-[#ADADAD]">Loading…</span>}
            />
            {agentName !== "—" && (
              <StatusRow ok label="Name" value={agentName} valueClass="text-[#555]" />
            )}
            <StatusRow
              ok={config.environment !== "dev"}
              okColor={config.environment === "live" ? "bg-green-500" : config.environment === "beta" ? "bg-yellow-400" : "bg-blue-400"}
              label="Env"
              value={config.environment === "live" ? "Production" : config.environment === "beta" ? "Beta" : "Dev"}
              valueClass="text-[#555]"
            />
            <StatusRow
              ok={true}
              okColor="bg-green-500"
              label="Credentials"
              value="Server-managed"
              valueClass="text-green-600"
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
