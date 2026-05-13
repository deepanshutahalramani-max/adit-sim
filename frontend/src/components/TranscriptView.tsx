import { Turn } from "../api/runs";

interface Props {
  turns: Turn[];
  isLive?: boolean;
}

export function TranscriptView({ turns, isLive }: Props) {
  if (turns.length === 0) {
    return (
      <div className="text-sm text-gray-400 italic py-8 text-center">
        {isLive ? "Waiting for first message…" : "No transcript available."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {turns.map((turn) => {
        const isPatient = turn.direction === "outbound";
        return (
          <div
            key={turn.id}
            className={`flex gap-3 ${isPatient ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                isPatient
                  ? "bg-brand-500 text-white rounded-br-sm"
                  : "bg-white border border-gray-200 text-gray-800 rounded-bl-sm"
              }`}
            >
              <div className="font-medium text-xs mb-1 opacity-70">
                {isPatient ? "Patient (Simulator)" : "AI Agent"}
              </div>
              <div className="whitespace-pre-wrap">{turn.content}</div>
              <div className="text-xs mt-1 opacity-50 text-right">
                {new Date(turn.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        );
      })}
      {isLive && (
        <div className="flex justify-start">
          <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-gray-400 italic">
            Waiting for reply…
          </div>
        </div>
      )}
    </div>
  );
}
