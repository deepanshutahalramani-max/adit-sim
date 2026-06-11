/**
 * E2E Chain — the Patient Journey over REAL phone:
 * one patient identity, one test number — Book → Reschedule → Cancel
 * as actual conversations with the practice number.
 */
import type { Config } from "../types";
import { PromptConfigurator } from "../components/PromptConfigurator";
import { RealRunPanel } from "../components/RealRunPanel";
import { IdentityBoard } from "../components/RealOps";
import { realEnv } from "./Simulations";

interface Props {
  config: Config;
}

const PHASES = [
  { id: "new-patient-cleaning", label: "Book",       icon: "🆕", desc: "New patient books a cleaning appointment" },
  { id: "reschedule",           label: "Reschedule", icon: "🔄", desc: "Same patient moves the appointment" },
  { id: "cancel",               label: "Cancel",     icon: "❌", desc: "Same patient cancels it" },
];

export function E2EChain({ config }: Props) {
  const env = realEnv(config.environment);

  if (!env) {
    return (
      <div className="text-[13px] text-[#92600A] bg-[#FFF7E6] border border-[#F5D998] rounded-2xl p-6">
        Real-phone testing supports <b>Live (PROD)</b> and <b>Beta</b> — switch the environment in the sidebar.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Patient Journey</h1>
        <p className="text-[13.5px] text-[#888] leading-relaxed">
          One identity, one number, three real conversations — exercises the full appointment
          lifecycle exactly as a real patient would, visible in the ADIT app end to end.
        </p>
      </div>

      {/* Phase cards */}
      <div className="grid grid-cols-3 gap-3">
        {PHASES.map((p, i) => (
          <div key={p.id} className="bg-white border border-[#EAEAEA] rounded-2xl p-4">
            <div className="text-[11px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">Phase {i + 1}</div>
            <div className="text-[15px] font-bold text-[#111]">{p.icon} {p.label}</div>
            <div className="text-[12px] text-[#888] mt-1 leading-snug">{p.desc}</div>
          </div>
        ))}
      </div>

      <PromptConfigurator agentPhone={config.agentPhone} agentId={config.smsAgentId} apiBase={config.apiBase} />

      <IdentityBoard env={env} />

      <div className="bg-white border border-[#EAEAEA] rounded-xl p-5">
        <div className="text-[13px] font-bold text-[#111] mb-1">🧭 Run the journey</div>
        <div className="text-[12px] text-[#888] mb-4">
          The platform pins one patient number for all three phases so the agent finds the same
          patient record at every step. Phases run sequentially (~10–15 minutes total).
        </div>
        <RealRunPanel
          env={env}
          kind="journey"
          allowedTriggers={["incomplete_call", "missed_call", "inbound_sms"]}
          buttonLabel="🧭 Run Patient Journey (Book → Reschedule → Cancel)"
        />
      </div>
    </div>
  );
}
