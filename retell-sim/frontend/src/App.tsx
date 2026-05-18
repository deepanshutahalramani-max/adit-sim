import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchConfig, fetchAgentInfo } from "./api";
import type { Config } from "./types";
import { Sidebar } from "./components/Sidebar";
import { SimulationsHub } from "./pages/SimulationsHub";
import { E2EChain } from "./pages/E2EChain";
import { DebugSuite } from "./pages/DebugSuite";
import { Dashboard } from "./pages/Dashboard";
import type { SimResult } from "./types";

const TABS = [
  { id: "debug",       label: "🔍 Debug Suite" },
  { id: "simulations", label: "💬 Simulations" },
  { id: "chain",       label: "E2E Chain" },
  { id: "dashboard",   label: "Dashboard" },
] as const;

type TabId = typeof TABS[number]["id"];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("debug");
  const [config, setConfig] = useState<Config>(() => {
    let bearer = localStorage.getItem("adit_bearer") ?? "";
    let openai = localStorage.getItem("adit_openai_key") ?? "";

    // Auto-fix: if OpenAI key was accidentally saved in bearer token field, swap them
    if (bearer.startsWith("sk-") && !openai) {
      openai = bearer;
      bearer = "";
      localStorage.setItem("adit_openai_key", openai);
      localStorage.setItem("adit_bearer", bearer);
    }

    return {
      environment: "live",
      apiBase: "https://frontdeskchatagent.adit.com",
      bearerToken: bearer,
      agentPhone: "+12673565689",
      openaiKey: openai,
      useLlmJudge: true,
    };
  });

  // Results tracked separately per channel
  const [smsResults, setSmsResults]   = useState<SimResult[]>([]);
  const [callResults, setCallResults] = useState<SimResult[]>([]);
  const [chainResults, setChainResults] = useState<Record<string, SimResult> | null>(null);

  const { data: appConfig } = useQuery({ queryKey: ["config"], queryFn: fetchConfig });

  // Fetch agent display info whenever the agent phone changes
  const { data: agentInfo } = useQuery({
    queryKey: ["agentInfo", config.agentPhone],
    queryFn: () => fetchAgentInfo(config.agentPhone),
    staleTime: 60_000,   // cache for 1 min — avoid hammering Retell on every keystroke
    retry: false,
  });
  const agentName = agentInfo?.call_agent_name || agentInfo?.sms_agent_name || "Siriyaa";

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
    <div className="flex h-screen bg-[#FAFAF8] overflow-hidden">
      <Sidebar config={config} onChange={setConfig} />

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
  );
}
