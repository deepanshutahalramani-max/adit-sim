/**
 * CustomScenario — define your own test case (goal + opening line) instead of a
 * preset. The AI patient pursues exactly this goal, so you can test anything
 * (e.g. "spinal compression") without being locked to a preset's service.
 * Runs over the real phone via the repro path (custom goal/opener).
 */
import { useState } from "react";
import { RealRunPanel } from "./RealRunPanel";

interface Props {
  env: string;
  practiceNumber?: string;
  allowedTriggers?: string[];
  channelLabel: string;   // "SMS" | "call"
}

export function CustomScenario({ env, practiceNumber, allowedTriggers, channelLabel }: Props) {
  const [goal, setGoal] = useState("");
  const [opener, setOpener] = useState("");
  const [runs, setRuns] = useState(1);
  const ready = goal.trim().length > 0;

  return (
    <div className="card card-pad space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900 tracking-[-0.01em]">Custom scenario</h2>
        <p className="text-[12.5px] text-ink-500 mt-1 leading-relaxed">
          Describe exactly what the patient wants — the AI patient pursues this instead of a preset,
          so you can test any case (e.g. a specific symptom or service) without defaulting to cleaning.
        </p>
      </div>

      <div>
        <div className="section-label mb-1.5">
          What does the patient want? <span className="text-ink-300 normal-case font-medium tracking-normal">required</span>
        </div>
        <textarea
          value={goal} onChange={e => setGoal(e.target.value)} rows={3}
          placeholder="e.g. New patient with spinal / neck compression pain — book the earliest appointment for that, describing the symptom when asked."
          className="field resize-none !text-[13px] leading-relaxed"
        />
      </div>

      <div>
        <div className="section-label mb-1.5">
          Opening message <span className="text-ink-300 normal-case font-medium tracking-normal">optional</span>
        </div>
        <input
          value={opener} onChange={e => setOpener(e.target.value)}
          placeholder="e.g. Hi, I've had neck compression pain and need to see someone."
          className="field"
        />
      </div>

      <div className="flex items-end gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Runs</span>
          <input
            type="number" min={1} max={5} value={runs}
            onChange={e => setRuns(Math.min(Math.max(1, parseInt(e.target.value) || 1), 5))}
            className="field !w-20 !py-2"
          />
        </label>
        <p className="text-[12px] text-ink-400 leading-snug flex-1">
          Runs this case {runs === 1 ? "once" : `${runs}×`} over the real {channelLabel}.
        </p>
      </div>

      <RealRunPanel
        env={env}
        practiceNumber={practiceNumber}
        kind="repro"
        goal={goal}
        opener={opener || undefined}
        label={`Custom: ${goal.trim().slice(0, 48)}`}
        repeat={runs}
        allowedTriggers={allowedTriggers}
        buttonLabel={`Run custom scenario${runs > 1 ? ` (${runs})` : ""}`}
        disabled={!ready}
        disabledReason={!ready ? "Describe what the patient wants above." : undefined}
      />
    </div>
  );
}
