import { Link } from "@tanstack/react-router";
import { useScenarios } from "../api/scenarios";
import { ScenarioCard } from "../components/ScenarioCard";

export function ScenariosIndexPage() {
  const { data: scenarios, isLoading } = useScenarios();

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Scenario Library</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {scenarios?.length ?? 0} scenarios — click any to start a new run
          </p>
        </div>
        <Link
          to="/runs/new"
          className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg"
        >
          New Run
        </Link>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400 text-center py-8">Loading…</div>
      ) : (
        <div className="space-y-3">
          {(scenarios ?? []).map((s) => (
            <ScenarioCard key={s.id} scenario={s} />
          ))}
        </div>
      )}
    </div>
  );
}
