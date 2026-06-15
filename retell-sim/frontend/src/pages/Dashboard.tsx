/**
 * Dashboard — comprehensive QA insights:
 *   Overview  → agent performance KPIs (pass rate, latency, triggers, scenarios, failures)
 *   API & Cost → performance + spend of every meaningful API call (Twilio/RingCentral/OpenAI)
 *   Sessions  → full filterable history of every real-phone test
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Activity, Stethoscope, FolderClock, TrendingUp } from "lucide-react";
import { RealInsights, SessionsExplorer, ApiPerformance, EhrApiFlow, TrendsView } from "../components/RealOps";
import { fetchRealConfig } from "../api";

type Section = "overview" | "trends" | "ehr" | "api" | "sessions";

const SECTIONS = [
  { id: "overview", label: "Overview",    icon: BarChart3 },
  { id: "trends",   label: "Trends",      icon: TrendingUp },
  { id: "ehr",      label: "EHR APIs",    icon: Stethoscope },
  { id: "api",      label: "Infra & Cost", icon: Activity },
  { id: "sessions", label: "Sessions",    icon: FolderClock },
] as const;

export function Dashboard() {
  const [section, setSection] = useState<Section>("overview");
  const { data: cfg } = useQuery({ queryKey: ["realConfig"], queryFn: fetchRealConfig, refetchInterval: 30_000 });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-canvas-raised border border-line rounded-xl p-1 w-fit shadow-card">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => setSection(s.id)}
                className={`flex items-center gap-2 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors ${
                  section === s.id ? "bg-brand-500 text-white shadow-brand" : "text-ink-500 hover:text-ink-900 hover:bg-canvas-sunken"
                }`}>
                <Icon className="w-4 h-4" strokeWidth={2.2} />
                {s.label}
              </button>
            );
          })}
        </div>
        {/* Persistence status */}
        <span className={`pill ${cfg?.supabase_configured ? "pill-ok" : "pill-warn"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${cfg?.supabase_configured ? "bg-[#22C55E]" : "bg-[#F59E0B]"}`} />
          {cfg?.supabase_configured ? "History persisted to Supabase" : "Ephemeral — set up Supabase for history"}
        </span>
      </div>

      {section === "overview" && <RealInsights />}
      {section === "trends"   && <TrendsView />}
      {section === "ehr"      && <EhrApiFlow />}
      {section === "api"      && <ApiPerformance />}
      {section === "sessions" && <SessionsExplorer />}
    </div>
  );
}
