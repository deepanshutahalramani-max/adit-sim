/**
 * Simulations → SMS — everything runs over REAL phone calls/SMS.
 *
 * AI Simulation: pick scenarios → each runs as a real conversation with the
 *   practice number (entry point: incomplete call / missed call / inbound SMS).
 * Manual Chat: you drive the patient side over real SMS through the platform.
 */
import { useState } from "react";
import type { Config, AppConfig } from "../types";
import { PromptConfigurator } from "../components/PromptConfigurator";
import { RealRunPanel } from "../components/RealRunPanel";
import { RealManualConsole } from "../components/RealManualConsole";
import { IdentityBoard } from "../components/RealOps";

/** Map sidebar environment to real-phone env */
export function realEnv(environment: string): "beta" | "prod" | null {
  if (environment === "live") return "prod";
  if (environment === "beta") return "beta";
  return null;
}

interface Props {
  config: Config;
  appConfig?: AppConfig;
}

type SubTab = "ai" | "manual";

export function Simulations({ config, appConfig }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
  const [subTab, setSubTab] = useState<SubTab>("ai");
  const [selected, setSelected] = useState<string[]>([]);
  const env = realEnv(config.environment);

  const toggleScenario = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAll = () =>
    setSelected(s => s.length === scenarios.length ? [] : scenarios.map(s => s.id));

  if (!env) {
    return (
      <div className="text-[13px] text-[#92600A] bg-[#FFF7E6] border border-[#F5D998] rounded-2xl p-6">
        Real-phone testing supports <b>Live (PROD)</b> and <b>Beta</b> — switch the environment in the sidebar.
      </div>
    );
  }

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex border-b border-[#EAEAEA] mb-6">
        {([
          { id: "ai",     label: "🤖  AI Simulation" },
          { id: "manual", label: "✏️  Manual Chat" },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === t.id
                ? "border-brand-500 text-[#111] font-semibold"
                : "border-transparent text-[#888] hover:text-[#333]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "ai" && (
        <div className="space-y-4">
          <PromptConfigurator agentPhone={config.agentPhone} agentId={config.smsAgentId} apiBase={config.apiBase} />

          {/* Patient test numbers */}
          <IdentityBoard env={env} />

          {/* Scenario picker */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold text-[#333]">Scenarios</h2>
              <button onClick={toggleAll} className="text-[12px] text-brand-500 font-medium hover:text-brand-600">
                {selected.length === scenarios.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {scenarios.map(sc => (
                <label key={sc.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  selected.includes(sc.id) ? "border-brand-500 bg-brand-50" : "border-[#E5E5E5] hover:border-[#D0D0D0]"
                }`}>
                  <input type="checkbox" checked={selected.includes(sc.id)}
                    onChange={() => toggleScenario(sc.id)} className="mt-0.5 accent-brand-500" />
                  <div>
                    <div className="text-[13px] font-semibold text-[#111]">{sc.label}</div>
                    <div className="text-[12px] text-[#888] mt-0.5 leading-snug">{sc.goal}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Run over real phone */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5">
            <div className="text-[13px] font-bold text-[#111] mb-1">📱 Run as real conversations</div>
            <div className="text-[12px] text-[#888] mb-4">
              Each scenario runs as a real call/SMS conversation with the practice number — results
              register in the ADIT app. Existing-patient scenarios auto-book the patient first.
            </div>
            <RealRunPanel
              env={env}
              kind="suite"
              scenarioIds={selected}
              allowedTriggers={["incomplete_call", "missed_call", "inbound_sms"]}
              buttonLabel={`📱 Run ${selected.length} scenario${selected.length === 1 ? "" : "s"}`}
              disabled={selected.length === 0}
              disabledReason={selected.length === 0 ? "Select at least one scenario above." : undefined}
            />
          </div>
        </div>
      )}

      {subTab === "manual" && <RealManualConsole env={env} />}
    </div>
  );
}
