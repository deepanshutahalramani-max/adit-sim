import { useEffect, useRef } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useRun } from "../api/runs";
import { useScenario } from "../api/scenarios";
import { TranscriptView } from "../components/TranscriptView";
import { EvalResultCard } from "../components/EvalResultCard";
import { CheckCircle, XCircle, Clock, Loader2, ArrowLeft } from "lucide-react";
import clsx from "clsx";

const ACTIVE_STATUSES = ["pending", "running", "awaiting_reply", "completing"];

function RunStatusHeader({
  status,
  error,
}: {
  status: string;
  error: string | null;
}) {
  const isActive = ACTIVE_STATUSES.includes(status);
  const icon =
    status === "completed" ? (
      <CheckCircle className="w-5 h-5 text-green-500" />
    ) : status === "failed" || status === "timeout" ? (
      <XCircle className="w-5 h-5 text-red-500" />
    ) : isActive ? (
      <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
    ) : (
      <Clock className="w-5 h-5 text-gray-400" />
    );

  const bg =
    status === "completed"
      ? "bg-green-50 border-green-200"
      : status === "failed" || status === "timeout"
      ? "bg-red-50 border-red-200"
      : isActive
      ? "bg-blue-50 border-blue-200"
      : "bg-gray-50 border-gray-200";

  return (
    <div className={clsx("flex items-center gap-3 border rounded-xl px-4 py-3 mb-6", bg)}>
      {icon}
      <div>
        <span className="font-semibold capitalize text-sm">{status.replace("_", " ")}</span>
        {isActive && (
          <span className="text-xs text-blue-600 ml-2">
            Live — refreshing automatically
          </span>
        )}
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </div>
    </div>
  );
}

export function RunDetailPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const { data: run, isLoading } = useRun(runId);
  const { data: scenario } = useScenario(run?.scenario_id ?? "");
  const transcriptBottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript as messages arrive
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [run?.turns?.length]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        Loading run…
      </div>
    );
  }

  if (!run) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-500">Run not found.</p>
        <Link to="/runs" className="text-brand-600 text-sm hover:underline mt-2 block">
          ← Back to runs
        </Link>
      </div>
    );
  }

  const isActive = ACTIVE_STATUSES.includes(run.status);
  const turns = run.turns ?? [];
  const evals = run.eval_results ?? [];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <Link
            to="/runs"
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            All runs
          </Link>
          <h1 className="text-xl font-bold">{scenario?.name ?? run.scenario_id}</h1>
          <p className="text-xs text-gray-400 font-mono mt-0.5">{run.id}</p>
        </div>
        <div className="text-right text-xs text-gray-400">
          <div>Provider: <span className="font-mono">{run.provider}</span></div>
          <div>Started: {new Date(run.started_at).toLocaleString()}</div>
          {run.completed_at && (
            <div>Completed: {new Date(run.completed_at).toLocaleString()}</div>
          )}
        </div>
      </div>

      <RunStatusHeader status={run.status} error={run.error} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Transcript */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Transcript
            <span className="ml-2 text-xs font-normal text-gray-400">
              {turns.length} turn{turns.length !== 1 ? "s" : ""}
            </span>
          </h2>
          <div className="flex-1 overflow-y-auto max-h-[520px] pr-1">
            <TranscriptView turns={turns} isLive={isActive} />
            <div ref={transcriptBottomRef} />
          </div>
        </div>

        {/* Evaluation */}
        <div className="flex flex-col gap-4">
          {/* Scenario info */}
          {scenario && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Scenario</h2>
              <p className="text-xs text-gray-500 mb-2">{scenario.description}</p>
              <div className="flex flex-wrap gap-1 mb-2">
                {scenario.persona_traits.map((t) => (
                  <span
                    key={t}
                    className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <div className="text-xs text-gray-400 mt-2">
                <span className="font-medium text-gray-500">Expected outcomes: </span>
                {Object.entries(scenario.expected_outcomes)
                  .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                  .join("  ·  ")}
              </div>
            </div>
          )}

          {/* Eval results */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Evaluation</h2>
            {isActive && evals.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                Evaluation runs after conversation ends.
              </p>
            ) : (
              <EvalResultCard eval_results={evals} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
