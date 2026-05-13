import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useRuns, RunsFilter } from "../api/runs";
import { useScenarios } from "../api/scenarios";
import { CheckCircle, XCircle, MinusCircle, Plus, RefreshCw } from "lucide-react";
import clsx from "clsx";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending:        { label: "Pending",        color: "bg-gray-100 text-gray-600" },
  running:        { label: "Running",        color: "bg-blue-100 text-blue-700" },
  awaiting_reply: { label: "Awaiting reply", color: "bg-yellow-100 text-yellow-700" },
  completing:     { label: "Completing",     color: "bg-blue-100 text-blue-700" },
  completed:      { label: "Completed",      color: "bg-green-100 text-green-700" },
  failed:         { label: "Failed",         color: "bg-red-100 text-red-700" },
  timeout:        { label: "Timeout",        color: "bg-orange-100 text-orange-700" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_LABELS[status] ?? { label: status, color: "bg-gray-100 text-gray-500" };
  return (
    <span className={clsx("text-xs font-medium px-2 py-0.5 rounded-full", cfg.color)}>
      {cfg.label}
    </span>
  );
}

function PassBadge({ passed }: { passed?: boolean | null }) {
  if (passed === true)
    return <span className="flex items-center gap-1 text-xs text-green-600 font-medium"><CheckCircle className="w-3.5 h-3.5" />Pass</span>;
  if (passed === false)
    return <span className="flex items-center gap-1 text-xs text-red-600 font-medium"><XCircle className="w-3.5 h-3.5" />Fail</span>;
  return <span className="flex items-center gap-1 text-xs text-gray-400"><MinusCircle className="w-3.5 h-3.5" />—</span>;
}

export function RunsIndexPage() {
  const [filters, setFilters] = useState<RunsFilter>({});
  const { data: runs, isLoading, refetch } = useRuns(filters);
  const { data: scenarios } = useScenarios();

  const scenarioMap = Object.fromEntries((scenarios ?? []).map((s) => [s.id, s.name]));

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Simulation Runs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {runs?.length ?? 0} run{runs?.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-500"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link
            to="/runs/new"
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg"
          >
            <Plus className="w-4 h-4" />
            New Run
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-wrap gap-3">
        <select
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          value={filters.scenario_id ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, scenario_id: e.target.value || undefined }))}
        >
          <option value="">All scenarios</option>
          {(scenarios ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <select
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          value={filters.status ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        <select
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          value={filters.passed === undefined ? "" : String(filters.passed)}
          onChange={(e) => setFilters((f) => ({
            ...f,
            passed: e.target.value === "" ? undefined : e.target.value === "true",
          }))}
        >
          <option value="">All results</option>
          <option value="true">Pass only</option>
          <option value="false">Fail only</option>
        </select>

        <input
          type="date"
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
          value={filters.date_from ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value || undefined }))}
        />
        <span className="self-center text-gray-400 text-sm">to</span>
        <input
          type="date"
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
          value={filters.date_to ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value || undefined }))}
        />

        {Object.values(filters).some(Boolean) && (
          <button
            onClick={() => setFilters({})}
            className="text-sm text-gray-400 hover:text-gray-600 underline ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        ) : !runs?.length ? (
          <div className="p-12 text-center">
            <p className="text-gray-400 text-sm mb-3">No runs yet.</p>
            <Link to="/runs/new" className="text-brand-600 text-sm font-medium hover:underline">
              Start your first simulation →
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Scenario</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Provider</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Result</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Started</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {scenarioMap[run.scenario_id] ?? run.scenario_id}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">
                      {run.provider}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3">
                    <PassBadge />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(run.started_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: run.id }}
                      className="text-brand-600 hover:underline text-xs font-medium"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
