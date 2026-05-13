import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useScenarios } from "../api/scenarios";
import { useCreateRun } from "../api/runs";
import { ScenarioCard } from "../components/ScenarioCard";
import { AlertCircle } from "lucide-react";

export function NewRunPage() {
  const navigate = useNavigate();
  const { data: scenarios, isLoading } = useScenarios();
  const createRun = useCreateRun();
  const [selectedScenario, setSelectedScenario] = useState<string>("");
  const [provider, setProvider] = useState<"mock" | "ringcentral">("mock");
  const [error, setError] = useState<string>("");

  const handleRun = async () => {
    if (!selectedScenario) {
      setError("Please select a scenario.");
      return;
    }
    setError("");
    try {
      const run = await createRun.mutateAsync({
        scenario_id: selectedScenario,
        provider,
      });
      navigate({ to: "/runs/$runId", params: { runId: run.id } });
    } catch (e: any) {
      setError(e.message ?? "Failed to start run");
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold">New Simulation Run</h1>
        <p className="text-sm text-gray-500 mt-1">
          Pick a scenario and messaging provider, then start.
        </p>
      </div>

      {/* Provider selector */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Messaging Provider</h2>
        <div className="flex gap-3">
          {(["mock", "ringcentral"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                provider === p
                  ? "border-brand-500 bg-brand-50 text-brand-700 ring-1 ring-brand-500"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              <div className="font-semibold capitalize">{p}</div>
              <div className="text-xs font-normal opacity-70 mt-0.5">
                {p === "mock"
                  ? "Zero deps — uses scripted replies"
                  : "Real SMS via RingCentral"}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Scenario selector */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Scenario</h2>
        {isLoading ? (
          <div className="text-sm text-gray-400 py-4 text-center">Loading scenarios…</div>
        ) : (
          <div className="space-y-2">
            {(scenarios ?? []).map((s) => (
              <ScenarioCard
                key={s.id}
                scenario={s}
                onSelect={setSelectedScenario}
                selected={selectedScenario === s.id}
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="flex gap-3 justify-end">
        <button
          onClick={() => navigate({ to: "/runs" })}
          className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleRun}
          disabled={!selectedScenario || createRun.isPending}
          className="px-6 py-2 text-sm font-semibold bg-brand-500 hover:bg-brand-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {createRun.isPending ? "Starting…" : "Run Simulation"}
        </button>
      </div>
    </div>
  );
}
