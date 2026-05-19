/**
 * LiveWebCall — connects to the REAL Retell call agent.
 *
 * Two modes:
 *   "manual"  — Retell calls the tester's real phone number (phone call API).
 *               Enter your phone number → agent dials you → live transcript polled.
 *   "ai"      — AI patient caller (GPT-4o-mini → OpenAI TTS → injected as mic audio)
 *               via WebRTC web-call. Agent audio transcribed from Retell transcript events.
 *
 * Manual backend: POST /api/retell/create-phone-call → { call_id }
 *                 GET  /api/retell/call-status/{call_id} (polled every 3s)
 * AI backend:     POST /api/retell/create-web-call → { access_token, call_id }
 *                 SDK: retell-client-js-sdk (RetellWebClient)
 */
import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Phone, PhoneOff, Mic, MicOff, Volume2 } from "lucide-react";
import clsx from "clsx";
// @ts-expect-error — retell-client-js-sdk may not ship types bundle
import { RetellWebClient } from "retell-client-js-sdk";

export type WebCallMode = "manual" | "ai";

export interface LiveWebCallParams {
  mode: WebCallMode;
  openai_key: string;           // needed for AI caller TTS + GPT responses
  agent_id?: string;            // explicit agent ID (overrides phone lookup)
  agent_phone?: string;         // sidebar phone → used as from_number for phone calls
  scenario_id?: string;         // used to pick the AI caller's opening line
  autoStart?: boolean;          // if true, call starts automatically on mount
  extra_context?: string;       // optional tester-provided context for AI patient behaviour
  repro_opener?: string;        // repro mode: exact first line AI caller should say
  repro_followups?: string[];   // repro mode: subsequent lines to guide AI
}

/** Imperative handle — lets parent components cut the call (e.g. Back button). */
export interface LiveWebCallHandle {
  endCall: () => void;
}

export interface LiveWebCallDoneResult {
  passed: boolean;
  outcome: string;
  transcript: TranscriptEntry[];
  call_id: string;
}

interface TranscriptEntry {
  role: "agent" | "user";
  content: string;
}

interface ApiEvent {
  text: string;
  ts: number;
}

interface Props {
  params: LiveWebCallParams;
  onDone: (result: LiveWebCallDoneResult) => void;
  onError?: (msg: string) => void;
}

// AI caller opening lines per scenario (phone-call register)
const AI_OPENERS: Record<string, string> = {
  "new-patient-cleaning":    "Hi, I'd like to schedule a new patient appointment for a cleaning.",
  "dental-emergency":        "Hi, I have a really bad toothache and I need to be seen today if possible.",
  "existing-routine":        "Hi, I'm an existing patient and I'd like to book a routine cleaning.",
  "reschedule":              "Hi, I need to reschedule my upcoming appointment.",
  "cancel":                  "Hi, I need to cancel my appointment please.",
  "insurance-book":          "Hi, I just wanted to check if you accept Delta Dental insurance.",
  "office-hours-book":       "Hi, can you tell me what your office hours are?",
  "post-treatment-followup": "Hi, I had a filling done last week and my tooth is still really sensitive.",
};

const DONE_KWS = [
  "appointment is confirmed", "you're all set", "all set",
  "appointment has been booked", "successfully booked",
  "appointment has been scheduled", "booking is confirmed",
  "appointment has been rescheduled", "successfully rescheduled",
  "appointment has been cancelled", "successfully cancelled",
  "i've created a note", "created a note for the team",
  "team will reach out", "someone will reach out",
  "created a task", "your request has been sent",
];

function formatTime(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const LiveWebCall = forwardRef<LiveWebCallHandle, Props>(function LiveWebCall({ params, onDone, onError }, ref) {
  const [status, setStatus]         = useState<"idle" | "connecting" | "active" | "done" | "error">("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [apiEvents, setApiEvents]   = useState<ApiEvent[]>([]);
  const [elapsed, setElapsed]       = useState(0);
  const [errorMsg, setErrorMsg]     = useState("");
  const [isMuted, setIsMuted]       = useState(false);
  const [outcome, setOutcome]       = useState<{ passed: boolean; label: string } | null>(null);
  const [agentSpeaking, setAgentSpeaking] = useState(false);

  // Manual mode — phone number the agent will call
  const [toNumber, setToNumber] = useState("");

  // Refs
  const clientRef      = useRef<RetellWebClient | null>(null);
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef       = useRef(0);
  const callIdRef      = useRef("");
  const bottomRef      = useRef<HTMLDivElement>(null);
  const transcriptRef  = useRef<TranscriptEntry[]>([]);
  const callEndedRef   = useRef(false);   // prevents double onDone from poll race
  const statusRef      = useRef<"idle" | "connecting" | "active" | "done" | "error">("idle");

  // AI caller state
  const audioCtxRef      = useRef<AudioContext | null>(null);
  const destNodeRef      = useRef<MediaStreamAudioDestinationNode | null>(null);
  const lastAgentTextRef = useRef("");
  const speakingRef      = useRef(false);
  const callActiveRef    = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, apiEvents]);

  useEffect(() => {
    // M1: autoStart only makes sense for AI mode — manual mode needs a phone number first
    if (params.autoStart && params.mode !== "manual") startCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    statusRef.current = status;
    if (status === "active") {
      startRef.current = Date.now();
      timerRef.current = setInterval(() =>
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    }
    if (status === "done" || status === "error") {
      if (timerRef.current) clearInterval(timerRef.current);
      callActiveRef.current = false;
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  // ── Infer API events from agent text ──────────────────────────────────────
  const inferEvents = (text: string): string[] => {
    const events: string[] = [];
    const t = text.toLowerCase();
    if (t.includes("create_new_patient") || (t.includes("new patient") && t.includes("register")))
      events.push("create_new_patient called");
    if (t.includes("fetch_patient") || t.includes("look up") || t.includes("found your record"))
      events.push("fetch_patient_details called");
    if (t.includes("book_appointment") || t.includes("confirmed") || t.includes("booked"))
      events.push("book_appointment called");
    if (t.includes("get_rescheduling") || t.includes("reschedule"))
      events.push("get_rescheduling_slot called");
    if (t.includes("modify_appointment") || t.includes("rescheduled") || t.includes("cancelled"))
      events.push("modify_appointment called");
    if (t.includes("create_task") || t.includes("note for the team") || t.includes("reach out"))
      events.push("create_task called");
    return events;
  };

  // ── AI caller: generate next patient response via backend ─────────────────
  const generateAiReply = useCallback(async (agentText: string, turnHistory: TranscriptEntry[]): Promise<string> => {
    const opener = params.repro_opener
      ?? AI_OPENERS[params.scenario_id ?? "new-patient-cleaning"]
      ?? "Hi, I need to schedule an appointment.";

    const history = turnHistory.map(t =>
      `${t.role === "user" ? "Caller" : "Agent"}: ${t.content}`
    ).join("\n");

    const reproScript = params.repro_followups?.length
      ? `\n\nREPRO SCRIPT — follow these lines in order after the opener:\n${params.repro_followups.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
      : "";
    const combined_context = (params.extra_context ?? "") + reproScript;

    const resp = await fetch("/api/ai-caller-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_text: agentText,
        history,
        opener,
        openai_key: params.openai_key,
        scenario_id: params.scenario_id ?? "new-patient-cleaning",
        extra_context: combined_context,
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    return data.reply as string;
  }, [params.openai_key, params.scenario_id, params.extra_context, params.repro_opener, params.repro_followups]);

  // ── AI caller: convert text to audio and inject into WebRTC mic ───────────
  const speakAsPatient = useCallback(async (text: string) => {
    if (!audioCtxRef.current || !destNodeRef.current) return;
    if (speakingRef.current) return;
    speakingRef.current = true;
    try {
      const ttsResp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, openai_key: params.openai_key, voice: "shimmer" }),
      });
      if (!ttsResp.ok) throw new Error("TTS failed");
      const arrayBuffer = await ttsResp.arrayBuffer();
      const audioCtx = audioCtxRef.current;
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(destNodeRef.current);
      source.start();
      await new Promise<void>(res => { source.onended = () => res(); });
    } catch (e) {
      console.warn("TTS injection error:", e);
    } finally {
      speakingRef.current = false;
    }
  }, [params.openai_key]);

  // ── MANUAL MODE: phone call flow ──────────────────────────────────────────
  const startPhoneCall = async () => {
    // C3: guard — agent phone must be configured
    if (!params.agent_phone) {
      setErrorMsg("Agent phone number is not configured in the sidebar.");
      return;
    }

    // H1: sanitize + validate E.164
    const cleaned = toNumber.trim().replace(/[\s\-().]/g, "");
    if (!cleaned) {
      setErrorMsg("Enter your phone number — the agent will call you on it.");
      return;
    }
    if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
      setErrorMsg("Phone number must be in E.164 format, e.g. +14155550100");
      return;
    }

    setStatus("connecting");
    callEndedRef.current = false;
    transcriptRef.current = [];
    setTranscript([]);
    setApiEvents([]);
    setOutcome(null);
    setErrorMsg("");
    setElapsed(0);

    try {
      const resp = await fetch("/api/retell/create-phone-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_number: params.agent_phone,
          to_number:   cleaned,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail ?? "Failed to create phone call");
      }
      const { call_id } = await resp.json();
      callIdRef.current = call_id;

      // H2: stay in "connecting" until Retell confirms the call is ongoing
      // Poll every 3s — flip to "active" on first "ongoing", stop on "ended"/"error"
      pollRef.current = setInterval(async () => {
        try {
          const pr = await fetch(`/api/retell/call-status/${call_id}`);
          if (!pr.ok) return;
          const data = await pr.json();

          // H2: flip to active once Retell says the call is live
          if (statusRef.current === "connecting" && data.call_status === "ongoing") {
            setStatus("active");
          }

          // Sync transcript (handles both "transcript" and "transcript_object" field names)
          const rawArr = data.transcript ?? data.transcript_object ?? [];
          const raw: Array<{ role: string; content: string }> = Array.isArray(rawArr) ? rawArr : [];
          if (raw.length) {
            const entries: TranscriptEntry[] = raw.map(t => ({
              role:    t.role === "agent" ? "agent" : "user",
              content: t.content ?? "",
            }));
            transcriptRef.current = entries;
            setTranscript(entries);
          }

          // H3 + C4: handle ended vs error, guard against double-fire
          if ((data.call_status === "ended" || data.call_status === "error") && !callEndedRef.current) {
            callEndedRef.current = true;
            if (pollRef.current) clearInterval(pollRef.current);

            if (data.call_status === "error") {
              const errMsg = data.call_analysis?.call_summary ?? "Retell reported a call error.";
              setErrorMsg(errMsg);
              setStatus("error");
              onError?.(errMsg);
            } else {
              const snap   = transcriptRef.current;
              const passed = snap.some(t => DONE_KWS.some(kw => t.content.toLowerCase().includes(kw)));
              setOutcome({ passed, label: passed ? "Goal reached ✓" : "Call ended — goal not reached" });
              setStatus("done");
              onDone({ passed, outcome: passed ? "completed" : "incomplete", transcript: snap, call_id });
            }
          }
        } catch { /* ignore transient poll errors */ }
      }, 3000);

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to start phone call";
      setErrorMsg(msg);
      setStatus("error");
      onError?.(msg);
    }
  };

  // ── AI MODE: WebRTC web-call flow ─────────────────────────────────────────
  const startWebCall = useCallback(async () => {
    setStatus("connecting");
    setTranscript([]);
    setApiEvents([]);
    setOutcome(null);
    setErrorMsg("");
    callActiveRef.current = true;

    try {
      const tokenResp = await fetch("/api/retell/create-web-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id:    params.agent_id,
          agent_phone: params.agent_phone,
          scenario_id: params.scenario_id,
          mode:        params.mode,
        }),
      });
      if (!tokenResp.ok) {
        const err = await tokenResp.json().catch(() => ({ detail: tokenResp.statusText }));
        throw new Error(err.detail ?? "Failed to create web call");
      }
      const { access_token, call_id } = await tokenResp.json();
      callIdRef.current = call_id;

      // Set up synthetic audio stream for AI caller
      const audioCtx = new AudioContext();
      const destNode = audioCtx.createMediaStreamDestination();
      audioCtxRef.current = audioCtx;
      destNodeRef.current = destNode;

      const fakeStream = destNode.stream;
      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints?.audio) return fakeStream;
        return origGUM(constraints);
      };
      (window as unknown as Record<string, unknown>)["__origGUM"] = origGUM;

      const client = new RetellWebClient();
      clientRef.current = client;

      client.on("call_started", () => {
        setStatus("active");
        const opener = params.repro_opener
          ?? AI_OPENERS[params.scenario_id ?? "new-patient-cleaning"]
          ?? "Hi, I need to schedule an appointment.";
        setTimeout(() => {
          if (callActiveRef.current) speakAsPatient(opener);
        }, 2500);
      });

      client.on("call_ended", () => {
        const snap   = transcriptRef.current;
        const passed = snap.some(t => DONE_KWS.some(kw => t.content.toLowerCase().includes(kw)));
        setOutcome({ passed, label: passed ? "Goal reached ✓" : "Call ended — goal not reached" });
        setStatus("done");
        onDone({ passed, outcome: passed ? "completed" : "incomplete", transcript: snap, call_id });
      });

      client.on("error", (err: Error) => {
        const msg = err?.message ?? "Call error";
        setErrorMsg(msg);
        setStatus("error");
        onError?.(msg);
      });

      client.on("update", (update: { transcript?: TranscriptEntry[] }) => {
        if (!update?.transcript) return;
        const entries = update.transcript;
        transcriptRef.current = entries;
        setTranscript(entries);
        const lastAgent = [...entries].reverse().find(e => e.role === "agent");
        if (lastAgent) {
          lastAgentTextRef.current = lastAgent.content;
          const evs = inferEvents(lastAgent.content);
          if (evs.length) {
            setApiEvents(prev => [...prev, ...evs.map(e => ({ text: e, ts: Date.now() }))]);
          }
        }
      });

      client.on("agent_start_talking", () => setAgentSpeaking(true));

      client.on("agent_stop_talking", () => {
        setAgentSpeaking(false);
        if (!callActiveRef.current || speakingRef.current) return;
        const entries  = transcriptRef.current;
        const lastAgent = [...entries].reverse().find(e => e.role === "agent");
        if (!lastAgent) return;
        if (DONE_KWS.some(kw => lastAgent.content.toLowerCase().includes(kw))) {
          setTimeout(() => { if (callActiveRef.current) client.stopCall(); }, 1500);
          return;
        }
        setTimeout(async () => {
          if (!callActiveRef.current || speakingRef.current) return;
          try {
            const reply = await generateAiReply(lastAgent.content, entries);
            if (callActiveRef.current) await speakAsPatient(reply);
          } catch (e) { console.warn("AI reply error:", e); }
        }, 400);
      });

      await client.startCall({ accessToken: access_token });

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to start call";
      setErrorMsg(msg);
      setStatus("error");
      onError?.(msg);
    }
  }, [params, generateAiReply, speakAsPatient, onDone, onError]);

  // ── Unified start ─────────────────────────────────────────────────────────
  const startCall = useCallback(async () => {
    if (params.mode === "manual") {
      await startPhoneCall();
    } else {
      await startWebCall();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.mode, toNumber, startWebCall]);

  // ── End call ──────────────────────────────────────────────────────────────
  const endCall = useCallback(() => {
    if (params.mode === "manual") {
      if (callEndedRef.current) return;  // already handled by poll
      callEndedRef.current = true;
      if (pollRef.current)  clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      const snap = transcriptRef.current;
      const passed = snap.some(t => DONE_KWS.some(kw => t.content.toLowerCase().includes(kw)));
      setOutcome({ passed, label: "Call ended by tester" });
      setStatus("done");
      onDone({ passed, outcome: "incomplete", transcript: snap, call_id: callIdRef.current });
    } else {
      clientRef.current?.stopCall();
      callActiveRef.current = false;
      const origGUM = (window as unknown as Record<string, unknown>)["__origGUM"];
      if (origGUM) {
        navigator.mediaDevices.getUserMedia = origGUM as typeof navigator.mediaDevices.getUserMedia;
        delete (window as unknown as Record<string, unknown>)["__origGUM"];
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close();
      }
    }
  }, [params.mode, onDone]);

  // H5: cleanup both intervals on unmount — prevents ghost setElapsed on unmounted component
  useEffect(() => {
    return () => {
      if (pollRef.current)  clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useImperativeHandle(ref, () => ({ endCall }), [endCall]);

  const toggleMute = () => {
    if (!clientRef.current) return;
    if (isMuted) clientRef.current.unmute();
    else         clientRef.current.mute();
    setIsMuted(m => !m);
  };

  const isActive     = status === "active";
  const isConnecting = status === "connecting";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-white border border-[#EAEAEA] rounded-2xl overflow-hidden shadow-sm">

      {/* ── Phone header ── */}
      <div className={clsx(
        "px-5 py-3.5 flex items-center gap-3 transition-colors duration-300",
        status === "idle"  ? "bg-[#1A1A1A]" :
        isConnecting       ? "bg-[#1A1A1A]" :
        isActive           ? "bg-[#1C3A1A]" :
        status === "done"  ? "bg-[#1C2B1A]" :
                             "bg-[#2B1A1A]",
      )}>
        <div className={clsx(
          "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0",
          isActive           ? "bg-green-500" :
          status === "done"  ? "bg-[#4CAF50]" :
          status === "error" ? "bg-red-500"   : "bg-[#333]",
        )}>
          {status === "done" || status === "error"
            ? <PhoneOff className="w-[18px] h-[18px] text-white" />
            : <Phone className={clsx("w-[18px] h-[18px] text-white", (isActive || isConnecting) && "animate-pulse")} />
          }
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-white leading-tight">
            {status === "idle"      ? (params.mode === "manual" ? "Manual Call — Ready" : "AI Caller — Ready") :
             status === "connecting" ? (params.mode === "manual" ? `Dialing ${toNumber}…` : "Connecting to Retell…") :
             isActive               ? (params.mode === "manual" ? `Connected → ${toNumber}` : "AI Caller active") :
             status === "done"      ? "Call ended" : "Call failed"}
          </div>
          <div className="text-[11px] text-white/50 mt-0.5">
            {isActive
              ? params.mode === "manual"
                ? `Outbound phone call · ${formatTime(elapsed)}`
                : `Real Retell agent · AI Caller · ${formatTime(elapsed)}`
              : status === "done"
              ? params.mode === "manual" ? `Outbound call ended · ${formatTime(elapsed)}` : `AI Caller ended · ${formatTime(elapsed)}`
              : params.mode === "manual"
              ? "Agent calls your phone number"
              : "GPT-4o-mini + TTS → Retell call agent"}
          </div>
        </div>

        {(isActive || status === "done") && (
          <div className={clsx(
            "text-[15px] font-mono font-bold tabular-nums",
            isActive ? "text-green-400" : "text-white/40",
          )}>
            {formatTime(elapsed)}
          </div>
        )}

        {isActive && agentSpeaking && params.mode === "ai" && (
          <div className="flex items-center gap-1 px-2.5 py-1 bg-green-500/20 rounded-full">
            <Volume2 className="w-3 h-3 text-green-400" />
            <span className="text-[10px] text-green-400 font-semibold">Agent</span>
          </div>
        )}
      </div>

      {/* ── Transcript ── */}
      <div className="h-80 overflow-y-auto p-4 space-y-3 bg-[#F7F7F5]">

        {/* Idle state */}
        {status === "idle" && params.mode === "manual" && (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-xs text-center">
              <div className="text-[32px] mb-3">📞</div>
              <div className="text-[13px] font-semibold text-[#555] mb-4">
                Enter your phone number — the agent will call you
              </div>
              <input
                type="tel"
                value={toNumber}
                onChange={e => setToNumber(e.target.value)}
                placeholder="+1 (415) 555-0100"
                className="w-full border border-[#E5E5E5] rounded-xl px-4 py-2.5 text-[14px] text-center focus:outline-none focus:border-green-400 mb-1"
              />
              <div className="text-[11px] text-[#ADADAD]">E.164 format, e.g. +14155550100</div>
            </div>
          </div>
        )}

        {status === "idle" && params.mode === "ai" && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="text-[32px] mb-3">🤖</div>
              <div className="text-[13px] font-semibold text-[#555]">
                Click Start Call — AI caller will talk to the real Retell agent
              </div>
              <div className="text-[11.5px] text-[#ADADAD] mt-1">
                Watch the transcript live as it happens
              </div>
            </div>
          </div>
        )}

        {/* Connecting — AI mode only (manual mode has its own connecting block below) */}
        {isConnecting && params.mode === "ai" && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-10 h-10 border-[3px] border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <div className="text-[13px] text-[#888]">Connecting to Retell…</div>
            </div>
          </div>
        )}

        {/* Active — phone call with no transcript yet */}
        {/* Connecting — waiting for Retell to dial */}
        {status === "connecting" && params.mode === "manual" && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-10 h-10 border-[3px] border-amber-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <div className="text-[13px] text-[#888]">Dialing {toNumber}…</div>
              <div className="text-[11px] text-[#ADADAD] mt-1">Pick up when your phone rings</div>
            </div>
          </div>
        )}

        {isActive && transcript.length === 0 && params.mode === "manual" && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-10 h-10 border-[3px] border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <div className="text-[13px] text-[#888]">Call connected — waiting for transcript…</div>
              <div className="text-[11px] text-[#ADADAD] mt-1">Updates every 3 seconds</div>
            </div>
          </div>
        )}

        {/* Transcript bubbles */}
        {transcript.map((entry, i) => (
          <div key={i}>
            {entry.role === "agent" && (() => {
              const evs = inferEvents(entry.content);
              return evs.length > 0 ? (
                <div className="flex flex-col items-center gap-1 my-2">
                  {evs.map((ev, j) => (
                    <div key={j} className="flex items-center gap-2 bg-[#F0F5FF] border border-[#C7D7FD] rounded-full px-3 py-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                      <span className="text-[11px] font-semibold text-blue-700">{ev}</span>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}

            {entry.role === "user" ? (
              <div className="flex items-start gap-2.5">
                <div className="w-7 h-7 bg-[#E8E8E6] rounded-full flex items-center justify-center text-[12px] flex-shrink-0 mt-0.5">
                  {params.mode === "manual" ? "🙋" : "🤖"}
                </div>
                <div>
                  <div className="text-[9.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-0.5">
                    {params.mode === "manual" ? "You" : "AI Caller"}
                  </div>
                  <div className="bg-white border border-[#E5E5E5] rounded-2xl rounded-tl-sm px-3.5 py-2 text-[13px] text-[#111] max-w-[300px] shadow-sm">
                    {entry.content}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 flex-row-reverse">
                <div className="w-7 h-7 bg-[#E8F5E9] rounded-full flex items-center justify-center text-[12px] flex-shrink-0 mt-0.5">🏥</div>
                <div className="text-right">
                  <div className="text-[9.5px] font-bold uppercase tracking-widest text-[#3B8A4A] mb-0.5">Agent</div>
                  <div className="bg-[#EAF6EB] border border-[#C6E8CA] rounded-2xl rounded-tr-sm px-3.5 py-2 text-[13px] text-[#1A3D1E] max-w-[300px] shadow-sm text-left">
                    {entry.content}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {isActive && transcript.length > 0 && transcript[transcript.length - 1].role === "user" && (
          <div className="flex items-center gap-2.5 flex-row-reverse">
            <div className="w-7 h-7 bg-[#E8F5E9] rounded-full flex items-center justify-center text-[12px] flex-shrink-0">🏥</div>
            <div className="bg-[#EAF6EB] border border-[#C6E8CA] rounded-2xl rounded-tr-sm px-3.5 py-2.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[#3B8A4A] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-[#3B8A4A] rounded-full animate-bounce" style={{ animationDelay: "160ms" }} />
              <span className="w-1.5 h-1.5 bg-[#3B8A4A] rounded-full animate-bounce" style={{ animationDelay: "320ms" }} />
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-[12px] text-red-700">⚠ {errorMsg}</div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Call-ended footer ── */}
      {status === "done" && outcome && (
        <div className={clsx(
          "px-5 py-3 flex items-center gap-3 border-t",
          outcome.passed ? "bg-green-50 border-green-100" : "bg-red-50 border-red-100",
        )}>
          <PhoneOff className={clsx("w-4 h-4 flex-shrink-0", outcome.passed ? "text-green-600" : "text-red-500")} />
          <span className={clsx("text-[13px] font-semibold", outcome.passed ? "text-green-700" : "text-red-600")}>
            {outcome.label}
          </span>
          <span className="ml-auto text-[11px] text-[#ADADAD]">{formatTime(elapsed)}</span>
        </div>
      )}

      {/* ── Controls ── */}
      <div className="px-5 py-3 border-t border-[#EAEAEA] bg-white flex items-center gap-3">

        {/* Manual mode idle — phone number input + call button */}
        {status === "idle" && params.mode === "manual" && (
          <>
            <input
              type="tel"
              value={toNumber}
              onChange={e => setToNumber(e.target.value)}
              onKeyDown={e => e.key === "Enter" && startCall()}
              placeholder="+14155550100"
              className="flex-1 border border-[#E5E5E5] rounded-xl px-3 py-2 text-[13px] focus:outline-none focus:border-green-400"
            />
            <button
              onClick={startCall}
              disabled={!toNumber.trim()}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-[13px] rounded-xl px-5 py-2.5 transition-colors shadow-sm"
            >
              <Phone className="w-4 h-4" />
              Call Me
            </button>
          </>
        )}

        {/* AI mode idle */}
        {status === "idle" && params.mode === "ai" && (
          <button
            onClick={startCall}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold text-[13px] rounded-xl px-5 py-2.5 transition-colors shadow-sm"
          >
            <Phone className="w-4 h-4" />
            Start Call
          </button>
        )}

        {isConnecting && (
          <button disabled className="flex items-center gap-2 bg-[#888] text-white font-semibold text-[13px] rounded-xl px-5 py-2.5 opacity-60 cursor-not-allowed">
            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            {params.mode === "manual" ? "Calling…" : "Connecting…"}
          </button>
        )}

        {isActive && (
          <>
            {/* AI mode: mute/unmute is irrelevant (TTS injection), but show for web-call completeness */}
            {params.mode === "ai" && (
              <button
                onClick={toggleMute}
                className={clsx(
                  "flex items-center gap-2 font-semibold text-[13px] rounded-xl px-4 py-2.5 transition-colors border",
                  isMuted
                    ? "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
                    : "bg-[#F5F5F5] text-[#333] border-[#E5E5E5] hover:bg-[#EBEBEB]",
                )}
              >
                {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                {isMuted ? "Unmute" : "Mute"}
              </button>
            )}

            {/* Phone call: polling indicator */}
            {params.mode === "manual" && (
              <div className="flex items-center gap-2 text-[11.5px] text-[#888]">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Live call in progress · polling transcript
              </div>
            )}

            <button
              onClick={endCall}
              className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold text-[13px] rounded-xl px-5 py-2.5 transition-colors shadow-sm ml-auto"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              {params.mode === "manual" ? "Stop Tracking" : "End Call"}
            </button>
          </>
        )}

        {(status === "done" || status === "error") && (
          <button
            onClick={() => {
              setStatus("idle");
              setTranscript([]);
              setApiEvents([]);
              setOutcome(null);
              setErrorMsg("");
              setElapsed(0);
              transcriptRef.current = [];
            }}
            className="flex items-center gap-2 bg-[#1A1A1A] hover:bg-[#333] text-white font-semibold text-[13px] rounded-xl px-5 py-2.5 transition-colors shadow-sm"
          >
            <Phone className="w-3.5 h-3.5" />
            {params.mode === "manual" ? "New Call" : "Call again"}
          </button>
        )}
      </div>
    </div>
  );
});
