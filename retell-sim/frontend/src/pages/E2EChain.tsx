/**
 * E2E Chain — the Patient Journey over REAL phone:
 * one patient identity, one test number — Book → Reschedule → Cancel
 * as actual conversations with the practice number.
 */
import { CalendarPlus, CalendarClock, CalendarX } from "lucide-react";
import type { Config } from "../types";
import { RealRunPanel } from "../components/RealRunPanel";
import { IdentityBoard } from "../components/RealOps";
import { realEnv, destNumber, envGuard } from "./Simulations";

interface Props {
  config: Config;
}

const PHASES = [
  { id: "new-patient-cleaning", label: "Book",       icon: CalendarPlus,  desc: "New patient books a cleaning appointment" },
  { id: "reschedule",           label: "Reschedule", icon: CalendarClock, desc: "Same patient moves the appointment" },
  { id: "cancel",               label: "Cancel",     icon: CalendarX,     desc: "Same patient cancels it" },
];

export function E2EChain({ config }: Props) {
  const env = realEnv(config.environment)!;
  const dest = destNumber(config);

  const guard = envGuard(config);
  if (guard) return <>{guard}</>;

  return (
    <div className="space-y-5">
      <p className="text-[13.5px] text-ink-500 leading-relaxed -mt-2">
        One identity, one number, three real conversations — exercises the full appointment
        lifecycle exactly as a real patient would, visible in the ADIT app end to end.
      </p>

      {/* Phase cards */}
      <div className="grid grid-cols-3 gap-3">
        {PHASES.map((p, i) => {
          const Icon = p.icon;
          return (
            <div key={p.id} className="card p-4">
              <div className="section-label mb-2">Phase {i + 1}</div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-ink-900 tracking-[-0.01em]">
                <Icon className="w-[18px] h-[18px] text-brand-500" strokeWidth={2} /> {p.label}
              </div>
              <div className="text-[12px] text-ink-500 mt-1 leading-snug">{p.desc}</div>
            </div>
          );
        })}
      </div>

      <IdentityBoard env={env} />

      <div className="card card-pad">
        <h2 className="text-[15px] font-semibold text-ink-900 tracking-[-0.01em]">Run the journey</h2>
        <p className="text-[12.5px] text-ink-500 mt-1 mb-4 leading-relaxed">
          The platform pins one patient number for all three phases so the agent finds the same
          patient record at every step. Phases run sequentially (~10–15 minutes total).
        </p>
        <RealRunPanel
          env={env}
          practiceNumber={dest}
          kind="journey"
          allowedTriggers={["incomplete_call", "missed_call", "inbound_sms"]}
          buttonLabel="Run Patient Journey"
        />
      </div>
    </div>
  );
}
