import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchConfig, fetchAgentInfo, fetchEnvConfig } from "./api";
import type { Config } from "./types";
import { Sidebar } from "./components/Sidebar";
import { AgentNameContext } from "./context/AgentNameContext";
import { SimulationsHub } from "./pages/SimulationsHub";
import { E2EChain } from "./pages/E2EChain";
import { DebugSuite } from "./pages/DebugSuite";
import { Dashboard } from "./pages/Dashboard";
import { RealPhone } from "./pages/RealPhone";
import type { SimResult } from "./types";

const TABS = [
  { id: "debug",       label: "🔍 Debug Suite" },
  { id: "simulations", label: "💬 Simulations" },
  { id: "realphone",   label: "📱 Real Phone" },
  { id: "chain",       label: "E2E Chain" },
  { id: "dashboard",   label: "Dashboard" },
] as const;

type TabId = typeof TABS[number]["id"];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("debug");
  const [config, setConfig] = useState<Config>(() => {
    const HOSTS: Record<string, string> = {
      live: "https://frontdeskchatagent.adit.com",
      beta: "https://betafrontdeskchatagent.adit.com",
      dev:  "https://gjqwwdfeo35edl-8009.proxy.runpod.net",
    };

    // Restore last-used environment (default live)
    const env = localStorage.getItem("adit_env") ?? "live";

    const phone       = localStorage.getItem("adit_agent_phone")        ?? "+12673565689";
    const smsAgentId  = localStorage.getItem(`adit_sms_agent_id_${env}`)  ?? "";
    const callAgentId = localStorage.getItem(`adit_call_agent_id_${env}`) ?? "";

    return {
      environment: env,
      apiBase: HOSTS[env] ?? HOSTS.live,
      agentPhone: phone,
      useLlmJudge: true,
      smsAgentId:  smsAgentId  || undefined,
      callAgentId: callAgentId || undefined,
      // bearer/openai now resolved server-side; keep empty so API calls stay compatible
      bearerToken: "",
      openaiKey:   "",
    };
  });

  // Results tracked separately per channel
  const [smsResults, setSmsResults]   = useState<SimResult[]>([]);
  const [callResults, setCallResults] = useState<SimResult[]>([]);
  const [chainResults, setChainResults] = useState<Record<string, SimResult> | null>(null);

  const { data: appConfig } = useQuery({ queryKey: ["config"], queryFn: fetchConfig });

  // Auto-load agent IDs + phone from server whenever the environment changes
  useEffect(() => {
    fetchEnvConfig(config.apiBase).then(ec => {
      setConfig(prev => ({
        ...prev,
        smsAgentId:  ec.sms_agent_id  || prev.smsAgentId,
        callAgentId: ec.call_agent_id || prev.callAgentId,
        agentPhone:  ec.agent_phone   || prev.agentPhone,
      }));
    }).catch(() => {/* silently ignore — server may not have PROD agent IDs configured */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiBase]);

  // Fetch agent display names using explicit agent IDs (highest priority) or phone fallback
  const { data: agentInfo } = useQuery({
    queryKey: ["agentInfo", config.smsAgentId, config.callAgentId, config.agentPhone, config.apiBase],
    queryFn: () => fetchAgentInfo(
      config.agentPhone || undefined,
      config.smsAgentId || undefined,
      config.callAgentId || undefined,
      config.apiBase || undefined,
    ),
    staleTime: 60_000,
    retry: false,
    enabled: !!(config.smsAgentId || config.callAgentId || config.agentPhone),
  });
  // Persona name ("Cimo") > dashboard name ("Test Agents…") > fallback
  const agentName = agentInfo?.persona_name || agentInfo?.call_agent_name || agentInfo?.sms_agent_name || "—";

  const handleSmsResults = (rs: SimResult[]) => {
    if (rs.length === 0) setSmsResults([]);
    else setSmsResults(prev => [...rs, ...prev]);
  };
  const handleCallResults = (rs: SimResult[]) => {
    if (rs.length === 0) setCallResults([]);
    else setCallResults(prev => [...rs, ...prev]);
  };

  // Dashboard gets all results combined
  const allResults = [...smsResults, ...callResults];

  return (
    <AgentNameContext.Provider value={agentName}>
    <div className="flex h-screen bg-[#FAFAF8] overflow-hidden">
      <Sidebar config={config} onChange={setConfig} agentName={agentName} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top header bar */}
        <header className="bg-white border-b border-[#EAEAEA] px-8 py-5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0">
              <img
                src="/adit-logo.svg"
                alt="ADIT"
                className="w-10 h-10 object-contain"
                onError={e => {
                  const t = e.currentTarget;
                  t.onerror = null;
                  t.style.display = "none";
                  (t.parentElement as HTMLElement).innerHTML =
                    '<div class="w-10 h-10 bg-brand-500 rounded-xl flex items-center justify-center text-white font-extrabold text-xl shadow-sm">a</div>';
                }}
              />
            </div>
            <div>
              <div className="text-xl font-extrabold text-[#111] leading-tight tracking-tight">Agent QA Platform</div>
              <div className="text-[13px] text-[#ADADAD] mt-0.5">AI Front Desk · Simulate, test and evaluate your receptionist</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-[13.5px] font-semibold text-[#333]">{agentName}</div>
              <div className="text-[11.5px] text-[#ADADAD]">Test QA · AI Agent</div>
            </div>
            <div className="flex items-center gap-1.5 bg-[#F2FDF4] border border-[#B8EFC8] px-3.5 py-1.5 rounded-full">
              <div className="w-[7px] h-[7px] bg-[#22C55E] rounded-full shadow-[0_0_0_3px_rgba(34,197,94,0.2)]" />
              <span className="text-[12.5px] font-semibold text-[#166534]">Live</span>
            </div>
          </div>
        </header>

        {/* Tab bar */}
        <nav className="bg-white border-b border-[#EAEAEA] px-8 flex-shrink-0">
          <div className="flex">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-5 py-3 text-[14px] font-medium border-b-2 transition-colors -mb-px ${
                  activeTab === tab.id
                    ? "border-brand-500 text-[#111] font-bold"
                    : "border-transparent text-[#888] hover:text-[#333]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Page content */}
        <main className="flex-1 overflow-auto px-8 py-8">
          <div className="max-w-[1160px] mx-auto">
            {activeTab === "debug" && (
              <DebugSuite config={config} onResults={handleSmsResults} />
            )}
            {activeTab === "simulations" && (
              <SimulationsHub
                config={config}
                appConfig={appConfig}
                onSmsResults={handleSmsResults}
                smsResults={smsResults}
                onCallResults={handleCallResults}
                callResults={callResults}
              />
            )}
            {activeTab === "realphone" && (
              <RealPhone />
            )}
            {activeTab === "chain" && (
              <E2EChain
                config={config}
                onResults={(rs) => { setChainResults(rs); handleSmsResults(Object.values(rs)); }}
                chainResults={chainResults}
              />
            )}
            {activeTab === "dashboard" && (
              <Dashboard results={allResults} chainResults={chainResults} />
            )}
          </div>
        </main>
      </div>
    </div>
    </AgentNameContext.Provider>
  );
}
