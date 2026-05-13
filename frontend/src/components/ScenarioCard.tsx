import { Scenario } from "../api/scenarios";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, ChevronRight } from "lucide-react";

interface Props {
  scenario: Scenario;
  onSelect?: (id: string) => void;
  selected?: boolean;
}

export function ScenarioCard({ scenario, onSelect, selected }: Props) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (onSelect) {
      onSelect(scenario.id);
    } else {
      navigate({ to: "/runs/new", search: { scenario_id: scenario.id } });
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`w-full text-left rounded-xl border p-4 transition-all hover:shadow-md ${
        selected
          ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
          : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <MessageSquare className="w-4 h-4 text-brand-500 flex-shrink-0" />
            <span className="font-semibold text-sm truncate">{scenario.name}</span>
          </div>
          <p className="text-xs text-gray-500 line-clamp-2 mb-2">{scenario.description}</p>
          <div className="flex flex-wrap gap-1">
            {scenario.persona_traits.slice(0, 4).map((trait) => (
              <span
                key={trait}
                className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600"
              >
                {trait}
              </span>
            ))}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-400 flex gap-4">
        <span>{scenario.mock_turn_count} scripted turns</span>
        <span className="text-gray-300">|</span>
        <span className="font-mono truncate">{scenario.opening_message.slice(0, 60)}…</span>
      </div>
    </button>
  );
}
