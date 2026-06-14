/**
 * Simulations → Call — REAL voice calls to the practice number.
 *
 * Each scenario places an actual phone call; the AI Front Desk answers and the
 * platform holds a live voice conversation (speech-to-text ↔ patient brain ↔ TTS).
 * Every call is recorded and playable from the session card / Dashboard.
 */
import { useState } from "react";
import type { Config, AppConfig } from "../types";
import { RealRunPanel } from "../components/RealRunPanel";
import { IdentityBoard } from "../components/RealOps";
import { realEnv, destNumber, envGuard } from "./Simulations";

interface Props {
  config: Config;
  appConfig?: AppConfig;
}

export function CallSimulations({ config, appConfig }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const env = realEnv(config.environment)!;
  const dest = destNumber(config);

  const toggleScenario = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAll = () =>
    setSelected(s => s.length === scenarios.length ? [] : scenarios.map(s => s.id));

  const guard = envGuard(config);
  if (guard) return <>{guard}</>;

  return (
    <div className="space-y-4">
      <IdentityBoard env={env} />

      <div className="bg-[#EAF3FF] border border-[#B5D4F5] rounded-xl p-4 text-[12.5px] text-[#1456A0]">
        🎙️ <b>Real voice calls.</b> The platform dials the practice number, the AI Front Desk answers,
        and an AI patient speaks each turn. Calls are <b>recorded</b> — play them back on the session
        card below or in the Dashboard. A full call takes 2–5 minutes.
      </div>

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

      {/* Run real voice calls */}
      <div className="bg-white border border-[#EAEAEA] rounded-xl p-5">
        <div className="text-[13px] font-bold text-[#111] mb-1">🎙️ Place real calls</div>
        <div className="text-[12px] text-[#888] mb-4">
          Calls run sequentially, one per patient number, and appear live below with the transcript
          as it happens and the recording when done.
        </div>
        <RealRunPanel
          env={env}
          practiceNumber={dest}
          kind="suite"
          scenarioIds={selected}
          allowedTriggers={["inbound_call"]}
          buttonLabel={`🎙️ Call ${selected.length} scenario${selected.length === 1 ? "" : "s"}`}
          disabled={selected.length === 0}
          disabledReason={selected.length === 0 ? "Select at least one scenario above." : undefined}
        />
      </div>
    </div>
  );
}
