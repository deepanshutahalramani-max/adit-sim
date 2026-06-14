/**
 * SimulationsHub — unified entry point for agent testing over REAL phone.
 *
 * 📱 SMS  → AI-driven scenario runs + manual chat console (real SMS)
 * 📞 Call → real voice calls with live transcript + recordings
 */
import { useState } from "react";
import { MessageSquare, Phone } from "lucide-react";
import type { Config, AppConfig } from "../types";
import { Simulations } from "./Simulations";
import { CallSimulations } from "./CallSimulations";

interface Props {
  config: Config;
  appConfig?: AppConfig;
}

type Channel = "sms" | "call";

const CHANNELS = [
  {
    id: "sms" as Channel,
    icon: MessageSquare,
    label: "SMS",
    badge: "Text agent",
    desc: "Real SMS conversations with the practice number — AI-driven or manual.",
  },
  {
    id: "call" as Channel,
    icon: Phone,
    label: "Call",
    badge: "Voice agent",
    desc: "Real phone calls — the AI Front Desk answers, every call recorded.",
  },
];

export function SimulationsHub({ config, appConfig }: Props) {
  const [channel, setChannel] = useState<Channel>("sms");

  return (
    <div>
      {/* ── Channel selector ── */}
      <div className="grid grid-cols-2 gap-3 mb-7 max-w-[640px]">
        {CHANNELS.map(ch => {
          const Icon = ch.icon;
          const active = channel === ch.id;
          return (
            <button
              key={ch.id}
              onClick={() => setChannel(ch.id)}
              className={`flex items-center gap-3.5 px-4 py-3.5 rounded-2xl border transition-all text-left ${
                active
                  ? "border-brand-300 bg-brand-50 shadow-card"
                  : "border-line bg-canvas-raised hover:border-line-strong hover:shadow-card"
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                active ? "bg-brand-500 shadow-brand" : "bg-canvas-sunken"
              }`}>
                <Icon className={`w-5 h-5 ${active ? "text-white" : "text-ink-400"}`} strokeWidth={2.2} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[14px] font-bold ${active ? "text-ink-900" : "text-ink-700"}`}>{ch.label}</span>
                  <span className={`pill !py-0.5 !text-[10px] ${active ? "pill-warn" : "pill-neutral"}`}>{ch.badge}</span>
                </div>
                <div className={`text-[11.5px] mt-0.5 leading-snug ${active ? "text-ink-500" : "text-ink-400"}`}>{ch.desc}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Channel content ── */}
      {channel === "sms"  && <Simulations config={config} appConfig={appConfig} />}
      {channel === "call" && <CallSimulations config={config} appConfig={appConfig} />}
    </div>
  );
}
