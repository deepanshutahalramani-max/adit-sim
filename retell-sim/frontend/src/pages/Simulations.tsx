/**
 * Simulations → SMS — everything runs over REAL phone calls/SMS.
 *
 * AI Simulation: pick scenarios → each runs as a real conversation with the
 *   practice number (entry point: incomplete call / missed call / inbound SMS).
 * Manual Chat: you drive the patient side over real SMS through the platform.
 */
import { useState } from "react";
import { Bot, PenLine } from "lucide-react";
import type { Config, AppConfig } from "../types";
import { RealRunPanel } from "../components/RealRunPanel";
import { RealManualConsole } from "../components/RealManualConsole";
import { IdentityBoard, ContextInput } from "../components/RealOps";

/** Map sidebar environment to real-phone env */
export function realEnv(environment: string): "beta" | "prod" | "custom" | null {
  if (environment === "live") return "prod";
  if (environment === "beta") return "beta";
  if (environment === "custom") return "custom";
  return null;
}

/** The destination number for a run: custom env uses the user-entered number;
 *  prod/beta use their configured practice number server-side (undefined). */
export function destNumber(config: Config): string | undefined {
  return config.environment === "custom" ? (config.customNumber || undefined) : undefined;
}

/** Shared guard: returns an error node if the env can't run, else null. */
export function envGuard(config: Config): JSX.Element | null {
  const env = realEnv(config.environment);
  if (!env) {
    return (
      <div className="card card-pad text-[13px] text-ink-700">
        Switch to <b>Production</b>, <b>Beta</b>, or <b>Custom</b> in the sidebar to run tests.
      </div>
    );
  }
  if (env === "custom" && !config.customNumber) {
    return (
      <div className="card card-pad text-[13px] text-ink-700">
        Custom environment selected — enter the <b>number to call / text</b> in the sidebar to begin.
      </div>
    );
  }
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
  const [ctx, setCtx] = useState("");
  const env = realEnv(config.environment)!;
  const dest = destNumber(config);

  const toggleScenario = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAll = () =>
    setSelected(s => s.length === scenarios.length ? [] : scenarios.map(s => s.id));

  const guard = envGuard(config);
  if (guard) return <>{guard}</>;

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-line mb-6">
        {([
          { id: "ai",     label: "AI Simulation", icon: Bot },
          { id: "manual", label: "Manual Chat",   icon: PenLine },
        ] as const).map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-[13px] border-b-2 -mb-px transition-colors ${
                subTab === t.id
                  ? "border-brand-500 text-ink-900 font-semibold"
                  : "border-transparent text-ink-400 hover:text-ink-700 font-medium"
              }`}
            >
              <Icon className="w-4 h-4" strokeWidth={2} />
              {t.label}
            </button>
          );
        })}
      </div>

      {subTab === "ai" && (
        <div className="space-y-5">
          {/* Patient test numbers */}
          <IdentityBoard env={env} />

          {/* Scenario picker */}
          <div className="card card-pad">
            <div className="flex items-center justify-between mb-3">
              <h2 className="section-label">Scenarios</h2>
              <button onClick={toggleAll} className="text-[12px] text-brand-600 font-semibold hover:text-brand-700">
                {selected.length === scenarios.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {scenarios.map(sc => (
                <label key={sc.id} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  selected.includes(sc.id) ? "border-brand-500 bg-brand-50" : "border-line hover:border-line-strong"
                }`}>
                  <input type="checkbox" checked={selected.includes(sc.id)}
                    onChange={() => toggleScenario(sc.id)} className="mt-0.5 accent-brand-500" />
                  <div>
                    <div className="text-[13px] font-semibold text-ink-900">{sc.label}</div>
                    <div className="text-[12px] text-ink-500 mt-0.5 leading-snug">{sc.goal}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Run over real phone */}
          <div className="card card-pad">
            <h2 className="text-[15px] font-semibold text-ink-900 tracking-[-0.01em]">Run as real conversations</h2>
            <p className="text-[12.5px] text-ink-500 mt-1 mb-4 leading-relaxed">
              Each scenario runs as a real call/SMS with the {env === "custom" ? "number you entered" : "practice number"},
              so results register in the agent’s system.
            </p>
            <div className="mb-5">
              <ContextInput value={ctx} onChange={setCtx} />
            </div>
            <RealRunPanel
              env={env}
              practiceNumber={dest}
              kind="suite"
              scenarioIds={selected}
              extraContext={ctx}
              allowedTriggers={["incomplete_call", "missed_call", "inbound_sms"]}
              buttonLabel={`Run ${selected.length} scenario${selected.length === 1 ? "" : "s"}`}
              disabled={selected.length === 0}
              disabledReason={selected.length === 0 ? "Select at least one scenario above." : undefined}
            />
          </div>
        </div>
      )}

      {subTab === "manual" && <RealManualConsole env={env} practiceNumber={dest} />}
    </div>
  );
}
