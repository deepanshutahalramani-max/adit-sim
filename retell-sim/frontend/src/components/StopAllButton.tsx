/**
 * StopAllButton — always-visible kill switch in the header.
 * Shows a live count of in-flight calls/SMS and halts everything at once:
 * aborts running suites (stops new conversations spawning) and ends every
 * active session, hanging up any live calls.
 */
import { useState } from "react";
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
        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-bold border-2 transition-all ${
          busy
            ? "bg-[#FEF2F2] text-[#991B1B] border-[#FCA5A5] hover:bg-[#FEE2E2] cursor-pointer shadow-sm"
            : "bg-[#F4F4F2] text-[#ADADAD] border-[#EAEAEA] cursor-default"
        }`}
        title={busy ? "Stop all running calls and SMS now" : "Nothing is running"}
      >
        <span className={`inline-block w-[9px] h-[9px] rounded-full ${
          busy ? "bg-[#EF4444] animate-pulse shadow-[0_0_0_3px_rgba(239,68,68,0.25)]" : "bg-[#CBCBC8]"
        }`} />
        {busy ? (
          <span>⏹ Stop All · {count} live{suites > 0 ? ` · ${suites} suite${suites > 1 ? "s" : ""}` : ""}</span>
        ) : (
          <span>Idle — nothing running</span>
        )}
      </button>

      {open && busy && (
        <div className="absolute right-0 mt-2 w-[320px] bg-white border border-[#EAEAEA] rounded-2xl shadow-xl z-50 p-4">
          <div className="text-[13.5px] font-bold text-[#111] mb-1">Stop all communication?</div>
          <div className="text-[12px] text-[#888] mb-3">
            This ends <b>{count}</b> active conversation{count !== 1 ? "s" : ""}
            {suites > 0 ? ` and aborts ${suites} running suite${suites > 1 ? "s" : ""}` : ""},
            hanging up any live calls immediately. In-progress real calls/SMS stop at once.
          </div>
          {(data?.sessions?.length ?? 0) > 0 && (
            <div className="max-h-[140px] overflow-auto mb-3 space-y-1">
              {data!.sessions.map(s => (
                <div key={s.session_id} className="text-[11.5px] text-[#555] flex items-center gap-2">
                  <span className="inline-block w-[5px] h-[5px] rounded-full bg-[#EF4444] animate-pulse" />
                  <span className="font-semibold">{s.env.toUpperCase()}</span>
                  <span className="truncate">{s.label}</span>
                  <span className="text-[#ADADAD] ml-auto">{s.status.replace(/_/g, " ")}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              className="flex-1 bg-[#DC2626] hover:bg-[#B91C1C] disabled:opacity-50 text-white font-bold text-[13px] py-2 rounded-lg"
            >
              {stop.isPending ? "Stopping…" : "Yes, stop everything"}
            </button>
            <button onClick={() => setOpen(false)}
              className="px-4 text-[13px] font-semibold text-[#888] border border-[#EAEAEA] rounded-lg hover:bg-[#F7F7F5]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
