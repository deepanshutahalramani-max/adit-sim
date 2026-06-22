/**
 * Simulations → Call — REAL voice calls to the practice number.
 *
 * Each scenario places an actual phone call; the AI Front Desk answers and the
 * platform holds a live voice conversation (speech-to-text ↔ patient brain ↔ TTS).
 * Every call is recorded and playable from the session card / Dashboard.
 */
import { useState } from "react";
import { Mic, Check } from "lucide-react";
import type { Config, AppConfig } from "../types";
import { RealRunPanel } from "../components/RealRunPanel";
import { IdentityBoard, ContextInput } from "../components/RealOps";
import { CustomScenario } from "../components/CustomScenario";
import { realEnv, destNumber, envGuard } from "./Simulations";
import { scenarioIcon, cleanScenarioLabel } from "../lib/scenarios";

interface Props {
  config: Config;
  appConfig?: AppConfig;
}

export function CallSimulations({ config, appConfig }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
  const [scenMode, setScenMode] = useState<"preset" | "custom">("preset");
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

      {/* Preset vs custom */}
      <div className="inline-flex gap-1 p-1 bg-canvas-sunken rounded-xl border border-line">
        {([["preset", "Preset scenarios"], ["custom", "Custom scenario"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setScenMode(id)}
            className={`text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors ${
              scenMode === id ? "bg-canvas-raised text-ink-900 shadow-card" : "text-ink-400 hover:text-ink-700"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {scenMode === "custom" ? (
        <CustomScenario env={env} practiceNumber={dest} allowedTriggers={["inbound_call"]} channelLabel="call" />
      ) : (
      <>
      {/* Scenario picker */}
      <div className="card card-pad">
        <div className="flex items-center justify-between mb-3">
          <h2 className="section-label">Scenarios</h2>
          <button onClick={toggleAll} className="text-[12px] text-brand-600 font-semibold hover:text-brand-700">
            {selected.length === scenarios.length ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {scenarios.map(sc => {
            const Icon = scenarioIcon(sc.id);
            const on = selected.includes(sc.id);
            return (
              <button key={sc.id} type="button" onClick={() => toggleScenario(sc.id)}
                className={`relative flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all ${
                  on ? "border-brand-500 bg-brand-50" : "border-line hover:border-line-strong hover:bg-canvas"
                }`}>
                <span className={`w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 transition-colors ${
                  on ? "bg-brand-100 text-brand-600" : "bg-canvas-sunken text-ink-400"
                }`}>
                  <Icon className="w-[18px] h-[18px]" strokeWidth={2} />
                </span>
                <div className="min-w-0 pr-5">
                  <div className="text-[13px] font-semibold text-ink-900">{cleanScenarioLabel(sc.label)}</div>
                  <div className="text-[12px] text-ink-500 mt-0.5 leading-snug">{sc.goal}</div>
                </div>
                {on && <Check className="absolute top-3 right-3 w-4 h-4 text-brand-600" strokeWidth={2.5} />}
              </button>
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
      </>
      )}
    </div>
  );
}
