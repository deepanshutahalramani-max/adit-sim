/**
 * Scenario presentation helpers — give each scenario a clean label + a minimal
 * line icon, independent of whatever emoji the backend prefixes onto labels.
 */
import {
  UserPlus, Siren, CalendarCheck, CalendarClock, CalendarX,
  ShieldCheck, Clock, ClipboardList,
} from "lucide-react";

export const SCENARIO_ICON: Record<string, typeof UserPlus> = {
  "new-patient-cleaning": UserPlus,
  "dental-emergency": Siren,
  "existing-routine": CalendarCheck,
  "reschedule": CalendarClock,
  "cancel": CalendarX,
  "insurance-book": ShieldCheck,
  "office-hours-book": Clock,
  "create-task": ClipboardList,
};

/** The icon for a scenario id, with a sensible default. */
export function scenarioIcon(id: string): typeof UserPlus {
  return SCENARIO_ICON[id] ?? ClipboardList;
}

/** Strip any leading emoji/symbols the backend prefixes onto a label. */
export function cleanScenarioLabel(label: string): string {
  return (label ?? "").replace(/^[^\p{L}\p{N}(]+/u, "").trim();
}
