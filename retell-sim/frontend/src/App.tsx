import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Route, Bug, BarChart3, ShieldCheck, LogOut } from "lucide-react";
import { fetchConfig, fetchAgentInfo, fetchEnvConfig } from "./api";
import type { Config } from "./types";
import { Sidebar } from "./components/Sidebar";
import { AgentNameContext } from "./context/AgentNameContext";
import { useAuth } from "./context/AuthContext";
import { SimulationsHub } from "./pages/SimulationsHub";
import { E2EChain } from "./pages/E2EChain";
import { DebugSuite } from "./pages/DebugSuite";
import { Dashboard } from "./pages/Dashboard";
import { Admin } from "./pages/Admin";
import { StopAllButton } from "./components/StopAllButton";

const NAV = [
  { id: "simulations", label: "Simulations",     icon: MessageSquare, sub: "Run real call & SMS tests" },
  { id: "chain",       label: "Patient Journey",  icon: Route,         sub: "Book → reschedule → cancel" },
  { id: "debug",       label: "Debug Suite",      icon: Bug,           sub: "Diagnose & reproduce bugs" },
  { id: "dashboard",   label: "Dashboard",        icon: BarChart3,     sub: "Metrics & session history" },
  { id: "admin",       label: "Admin",            icon: ShieldCheck,   sub: "Users, usage & audit log", adminOnly: true },
] as const;

type TabId = typeof NAV[number]["id"];

const HOSTS: Record<string, string> = {
  live:   "https://frontdeskchatagent.adit.com",
  beta:   "https://betafrontdeskchatagent.adit.com",
  custom: "https://frontdeskchatagent.adit.com",  // placeholder; custom targets a user-entered number
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("simulations");
  const [config, setConfig] = useState<Config>(() => {
    const env = localStorage.getItem("adit_env") ?? "live";
    const phone       = localStorage.getItem("adit_agent_phone")        ?? "+12673565689";
    const smsAgentId  = localStorage.getItem(`adit_sms_agent_id_${env}`)  ?? "";
    const callAgentId = localStorage.getItem(`adit_call_agent_id_${env}`) ?? "";
    return {
      environment: env,
      customNumber: localStorage.getItem("adit_custom_number") ?? "",
      apiBase: HOSTS[env] ?? HOSTS.live,
      agentPhone: phone,
      useLlmJudge: true,
      smsAgentId:  smsAgentId  || undefined,
      callAgentId: callAgentId || undefined,
      bearerToken: "",
      openaiKey:   "",
    };
  });

  const { data: appConfig } = useQuery({ queryKey: ["config"], queryFn: fetchConfig });

  useEffect(() => {
    fetchEnvConfig(config.apiBase).then(ec => {
      setConfig(prev => ({
        ...prev,
        smsAgentId:  ec.sms_agent_id  || prev.smsAgentId,
        callAgentId: ec.call_agent_id || prev.callAgentId,
        agentPhone:  ec.agent_phone   || prev.agentPhone,
      }));
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiBase]);

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
  const agentName = agentInfo?.persona_name || agentInfo?.call_agent_name || agentInfo?.sms_agent_name || "—";

  const { user, signOut } = useAuth();
  const isAdmin = user?.is_admin ?? false;
  const nav = NAV.filter(n => !("adminOnly" in n && n.adminOnly) || isAdmin);

  const envMeta: Record<string, { label: string; dot: string; tone: string }> = {
    live:   { label: "Production", dot: "bg-[#22C55E]", tone: "text-[#15803D] bg-[#F0FDF4] border-[#BBF7D0]" },
    beta:   { label: "Beta",       dot: "bg-[#F59E0B]", tone: "text-[#B45309] bg-[#FFF7ED] border-[#FED7AA]" },
    custom: { label: "Custom",     dot: "bg-[#7C3AED]", tone: "text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]" },
  };
  const em = envMeta[config.environment] ?? envMeta.live;
  const current = NAV.find(n => n.id === activeTab)!;

  return (
    <AgentNameContext.Provider value={agentName}>
      <div className="flex h-screen bg-canvas overflow-hidden text-ink-900">
        <Sidebar
          config={config}
          onChange={setConfig}
          agentName={agentName}
          nav={nav}
          activeTab={activeTab}
          onNavigate={(id) => setActiveTab(id as TabId)}
        />

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Topbar */}
          <header className="bg-canvas-raised/80 backdrop-blur border-b border-line px-8 h-[68px] flex items-center justify-between flex-shrink-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-[17px] font-extrabold text-ink-900 leading-none truncate">{current.label}</h1>
                <span className={`pill ${em.tone} !text-[11px]`}>
                  <span className={`w-[6px] h-[6px] rounded-full ${em.dot}`} />
                  {em.label}
                </span>
              </div>
              <p className="text-[12.5px] text-ink-400 mt-1">{current.sub}</p>
            </div>
            <div className="flex items-center gap-4">
              <StopAllButton />
              <div className="h-8 w-px bg-line" />
              {user ? (
                <div className="flex items-center gap-2.5">
                  <div className="text-right leading-tight">
                    <div className="text-[12.5px] font-semibold text-ink-700 max-w-[180px] truncate">{user.name}</div>
                    <div className="text-[11px] text-ink-400">{user.is_admin ? "Admin" : "Member"}</div>
                  </div>
                  {user.picture
                    ? <img src={user.picture} alt="" className="w-9 h-9 rounded-full" referrerPolicy="no-referrer" />
                    : <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white font-bold text-[14px]">{user.name.charAt(0).toUpperCase()}</div>}
                  <button onClick={signOut} title="Sign out"
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-400 hover:text-ink-900 hover:bg-canvas-sunken transition-colors">
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <div className="text-right leading-tight">
                    <div className="text-[12.5px] font-semibold text-ink-700 max-w-[160px] truncate">{agentName}</div>
                    <div className="text-[11px] text-ink-400">AI Front Desk agent</div>
                  </div>
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white font-bold text-[14px] shadow-sm">
                    {agentName !== "—" ? agentName.charAt(0).toUpperCase() : "A"}
                  </div>
                </div>
              )}
            </div>
          </header>

          {/* Page content */}
          <main className="flex-1 overflow-auto px-8 py-8">
            <div className="max-w-[1180px] mx-auto animate-fade-in" key={activeTab}>
              {activeTab === "simulations" && <SimulationsHub config={config} appConfig={appConfig} />}
              {activeTab === "chain"       && <E2EChain config={config} />}
              {activeTab === "debug"       && <DebugSuite config={config} onResults={() => {}} />}
              {activeTab === "dashboard"   && <Dashboard />}
              {activeTab === "admin"       && (isAdmin ? <Admin /> : <div className="text-[13px] text-ink-400">Admin access required.</div>)}
            </div>
          </main>
        </div>
      </div>
    </AgentNameContext.Provider>
  );
}
