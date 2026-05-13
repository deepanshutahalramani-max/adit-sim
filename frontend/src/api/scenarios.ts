import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export interface Scenario {
  id: string;
  name: string;
  description: string;
  persona_description: string;
  persona_traits: string[];
  opening_message: string;
  expected_outcomes: Record<string, unknown>;
  end_conditions: Record<string, unknown>;
  mock_turn_count: number;
}

export function useScenarios() {
  return useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api.get<Scenario[]>("/scenarios"),
  });
}

export function useScenario(id: string) {
  return useQuery({
    queryKey: ["scenarios", id],
    queryFn: () => api.get<Scenario>(`/scenarios/${id}`),
    enabled: !!id,
  });
}
