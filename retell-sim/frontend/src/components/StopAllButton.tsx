/**
 * StopAllButton — always-visible kill switch in the header.
 * Shows a live count of in-flight calls/SMS and halts everything at once:
 * aborts running suites (stops new conversations spawning) and ends every
 * active session, hanging up any live calls.
 */
import { useState } from "react";
import { Square } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRealActive, stopAllReal } from "../api";

export function StopAllButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["realActive"],
    queryFn: fetchRealActive,
    refetchInterval: 3000,
  });

  const stop = useMutation({
    mutationFn: stopAllReal,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["realActive"] });
      qc.invalidateQueries({ queryKey: ["realSessions"] });
      qc.invalidateQueries({ queryKey: ["realSuites"] });
      setOpen(false);
    },
  });

  const busy = data?.busy ?? false;
  const count = (data?.active_sessions ?? 0);
  const suites = (data?.running_suites ?? 0);

  return (
    <div className="relative">
      <button
        onClick={() => (busy ? setOpen(o => !o) : undefined)}
        disabled={!busy}
        className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-semibold border transition-all ${
          busy
            ? "bg-[#FEF2F2] text-[#B91C1C] border-[#FCA5A5] hover:bg-[#FEE2E2] cursor-pointer"
            : "bg-canvas-sunken text-ink-300 border-line cursor-default"
        }`}
        title={busy ? "Stop all running calls and SMS now" : "Nothing is running"}
      >
        {busy ? (
          <>
            <span className="inline-block w-[8px] h-[8px] rounded-full bg-[#EF4444] animate-pulse" />
            <Square className="w-3.5 h-3.5 fill-current" strokeWidth={0} />
            Stop all · {count} live{suites > 0 ? ` · ${suites} suite${suites > 1 ? "s" : ""}` : ""}
          </>
        ) : (
          <>
            <span className="inline-block w-[8px] h-[8px] rounded-full bg-[#CBCBC8]" />
            Idle
          </>
        )}
      </button>

      {open && busy && (
        <div className="absolute right-0 mt-2 w-[320px] card shadow-pop z-50 p-4">
          <div className="text-[13.5px] font-semibold text-ink-900 mb-1">Stop all communication?</div>
          <div className="text-[12px] text-ink-500 mb-3 leading-relaxed">
            This ends <b>{count}</b> active conversation{count !== 1 ? "s" : ""}
            {suites > 0 ? ` and aborts ${suites} running suite${suites > 1 ? "s" : ""}` : ""},
            hanging up any live calls immediately.
          </div>
          {(data?.sessions?.length ?? 0) > 0 && (
            <div className="max-h-[140px] overflow-auto mb-3 space-y-1">
              {data!.sessions.map(s => (
                <div key={s.session_id} className="text-[11.5px] text-ink-500 flex items-center gap-2">
                  <span className="inline-block w-[5px] h-[5px] rounded-full bg-[#EF4444] animate-pulse flex-shrink-0" />
                  <span className="font-semibold flex-shrink-0">{s.env.toUpperCase()}</span>
                  <span className="truncate flex-1 min-w-0">{s.label}</span>
                  <span className="text-ink-300 flex-shrink-0 whitespace-nowrap">{s.status.replace(/_/g, " ")}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => stop.mutate()} disabled={stop.isPending} className="btn-danger btn-sm flex-1">
              {stop.isPending ? "Stopping…" : "Yes, stop everything"}
            </button>
            <button onClick={() => setOpen(false)} className="btn-secondary btn-sm">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
