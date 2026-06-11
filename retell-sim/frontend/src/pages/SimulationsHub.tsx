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
      {/* ── Page header ── */}
      <div className="mb-6">
        <h1 className="text-[22px] font-extrabold text-[#111] tracking-tight leading-tight mb-1">
          Simulations
        </h1>
        <p className="text-[13.5px] text-[#888]">
          Every test is a real call or SMS to the practice number — exactly the path a real patient takes,
          fully visible in the ADIT app.
        </p>
      </div>

      {/* ── Channel selector ── */}
      <div className="flex gap-3 mb-8">
        {CHANNELS.map(ch => {
          const Icon = ch.icon;
          const active = channel === ch.id;
          return (
            <button
              key={ch.id}
              onClick={() => setChannel(ch.id)}
              className={`
                flex items-center gap-3 px-5 py-3.5 rounded-2xl border-2 transition-all
                text-left flex-1 max-w-[280px]
                ${active
                  ? ch.id === "sms"
                    ? "border-brand-500 bg-brand-50 shadow-sm"
                    : "border-[#1A1A1A] bg-[#F5F5F5] shadow-sm"
                  : "border-[#E5E5E5] bg-white hover:border-[#ADADAD]"
                }
              `}
            >
              <div className={`
                w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
                ${active
                  ? ch.id === "sms" ? "bg-brand-500" : "bg-[#1A1A1A]"
                  : "bg-[#F0F0EE]"
                }
              `}>
                <Icon className={`w-5 h-5 ${active ? "text-white" : "text-[#888]"}`} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[14px] font-bold ${active ? "text-[#111]" : "text-[#555]"}`}>
                    {ch.label}
                  </span>
                  <span className={`
                    text-[10px] font-bold px-1.5 py-0.5 rounded-full
                    ${active
                      ? ch.id === "sms"
                        ? "bg-brand-100 text-brand-700"
                        : "bg-[#E8E8E8] text-[#555]"
                      : "bg-[#F0F0EE] text-[#ADADAD]"
                    }
                  `}>
                    {ch.badge}
                  </span>
                </div>
                <div className={`text-[11.5px] mt-0.5 leading-snug ${active ? "text-[#555]" : "text-[#ADADAD]"}`}>
                  {ch.desc}
                </div>
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
