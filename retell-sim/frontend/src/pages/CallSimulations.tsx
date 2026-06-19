/**
 * Simulations → Call — REAL voice calls to the practice number.
 *
 * Each scenario places an actual phone call; the AI Front Desk answers and the
 * platform holds a live voice conversation (speech-to-text ↔ patient brain ↔ TTS).
 * Every call is recorded and playable from the session card / Dashboard.
 */
import { useState } from "react";
import { Mic } from "lucide-react";
import type { Config, AppConfig } from "../types";
import { RealRunPanel } from "../components/RealRunPanel";
import { IdentityBoard, ContextInput } from "../components/RealOps";
import { realEnv, destNumber, envGuard } from "./Simulations";
import { scenarioIcon, cleanScenarioLabel } from "../lib/scenarios";

interface Props {
  config: Config;
  appConfig?: AppConfig;
}

export function CallSimulations({ config, appConfig }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
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
    <div className="space-y-5">
      <IdentityBoard env={env} />

      <div className="card card-pad flex gap-3 text-[12.5px] text-ink-600 leading-relaxed">
        <Mic className="w-4 h-4 mt-0.5 flex-shrink-0 text-brand-500" strokeWidth={2} />
        <p>
          <b className="text-ink-900">Real voice calls.</b> The platform dials the practice number, the AI Front Desk
          answers, and an AI patient speaks each turn. Calls are recorded — play them back on the session card below or
          in the Dashboard. A full call takes 2–5 minutes.
        </p>
      </div>

      {/* Scenario picker */}
      <div className="card card-pad">
        <div className="flex items-center justify-between mb-3">
          <h2 className="section-label">Scenarios</h2>
          <button onClick={toggleAll} className="text-[12px] text-brand-600 font-semibold hover:text-brand-700">
            {selected.length === scenarios.length ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {scenarios.map(sc => {
            const Icon = scenarioIcon(sc.id);
            const on = selected.includes(sc.id);
            return (
              <label key={sc.id} className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                on ? "border-brand-500 bg-brand-50" : "border-line hover:border-line-strong"
              }`}>
                <input type="checkbox" checked={on}
                  onChange={() => toggleScenario(sc.id)} className="mt-1 accent-brand-500" />
                <span className={`mt-0.5 flex-shrink-0 ${on ? "text-brand-600" : "text-ink-400"}`}>
                  <Icon className="w-[18px] h-[18px]" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink-900">{cleanScenarioLabel(sc.label)}</div>
                  <div className="text-[12px] text-ink-500 mt-0.5 leading-snug">{sc.goal}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* Run real voice calls */}
      <div className="card card-pad">
        <h2 className="text-[15px] font-semibold text-ink-900 tracking-[-0.01em]">Place real calls</h2>
        <p className="text-[12.5px] text-ink-500 mt-1 mb-4 leading-relaxed">
          Calls appear live below with the transcript as it happens and the recording when done.
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
          allowedTriggers={["inbound_call"]}
          buttonLabel={`Call ${selected.length} scenario${selected.length === 1 ? "" : "s"}`}
          disabled={selected.length === 0}
          disabledReason={selected.length === 0 ? "Select at least one scenario above." : undefined}
        />
      </div>
    </div>
  );
}
