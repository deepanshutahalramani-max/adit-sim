import { createContext, useContext } from "react";

/**
 * Provides the AI persona name (e.g. "Cimo") extracted from the agent's
 * system prompt. Falls back to "Agent" so every consumer always has a label.
 */
export const AgentNameContext = createContext<string>("Agent");

export function useAgentName(): string {
  return useContext(AgentNameContext);
}
