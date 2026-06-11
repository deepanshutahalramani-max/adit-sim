/**
 * Dashboard — engineering performance metrics + full session history
 * for everything that ran over the real phone path.
 */
import { useState } from "react";
import { RealInsights, SessionsExplorer } from "../components/RealOps";

type Section = "insights" | "sessions";

export function Dashboard() {
  const [section, setSection] = useState<Section>("insights");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Dashboard</h1>
        <p className="text-[13.5px] text-[#888]">
          Performance metrics and full history of every real-phone test session.
        </p>
      </div>

      <div className="flex gap-1 bg-white border border-[#EAEAEA] rounded-xl p-1 w-fit">
        {([
          { id: "insights", label: "📊 Insights" },
          { id: "sessions", label: "🗂 Sessions" },
        ] as const).map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors ${
              section === s.id ? "bg-brand-500 text-white" : "text-[#888] hover:text-[#333]"
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {section === "insights" && <RealInsights />}
      {section === "sessions" && <SessionsExplorer />}
    </div>
  );
}
