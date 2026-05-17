import { useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { runParallel } from "../api";
import type { Config, AppConfig, SimResult } from "../types";
import { SimResultCard } from "../components/SimResultCard";
import { ManualSMS } from "../components/ManualSMS";

interface Props {
  config: Config;
  appConfig?: AppConfig;
  onResults: (rs: SimResult[]) => void;
  results: SimResult[];
}

type SubTab = "ai" | "manual";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-brand-500 rounded-xl px-5 py-4 shadow-sm">
      <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">{label}</div>
      <div className="text-[30px] font-extrabold text-[#111] leading-none tracking-tight">{value}</div>
    </div>
  );
}

export function Simulations({ config, appConfig, onResults, results }: Props) {
  const scenarios = appConfig?.scenarios ?? [];
  const [subTab, setSubTab]     = useState<SubTab>("ai");
  const [selected, setSelected] = useState<string[]>([]);
  const [repeats, setRepeats]   = useState(1);
  const [parallel, setParallel] = useState(5);
  const [running, setRunning]   = useState(false);
  const [error, setError]       = useState("");

  const toggleScenario = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAll = () =>
    setSelected(s => s.length === scenarios.length ? [] : scenarios.map(s => s.id));

  const handleRun = async () => {
    if (!config.bearerToken) { setError("Bearer token required in sidebar."); return; }
    if (selected.length === 0) { setError("Select at least one scenario."); return; }
    setError(""); setRunning(true);
    try {
      const res = await runParallel({
        scenario_ids: selected, repeats, max_parallel: parallel,
        api_base: config.apiBase, bearer_token: config.bearerToken,
        agent_phone: config.agentPhone, openai_key: config.openaiKey,
        use_judge: config.useLlmJudge,
      });
      onResults(res.results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const nPass    = results.filter(r => r.passed).length;
  const avgScore = results.length ? Math.round(results.reduce((a, b) => a + b.score, 0) / results.length) : 0;
  const avgMs    = results.length ? results.reduce((a, b) => a + b.total_ms, 0) / results.length : 0;

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex border-b border-[#EAEAEA] mb-6">
        {([
          { id: "ai",     label: "🤖  AI Simulation",  desc: "Automated, real agent" },
          { id: "manual", label: "✏️  Manual Chat",     desc: "You as patient, real agent" },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === t.id
                ? "border-brand-500 text-[#111] font-semibold"
                : "border-transparent text-[#888] hover:text-[#333]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════ AI SIMULATION TAB ══════════ */}
      {subTab === "ai" && (
        <>
          {/* Scenario picker */}
          <div className="bg-white border border-[#EAEAEA] rounded-xl p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold text-[#333]">Scenarios</h2>
              <button onClick={toggleAll} className="text-[12px] text-brand-500 font-medium hover:text-brand-600">
                {selected.length === scenarios.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {scenarios.map(sc => (
                <label key={sc.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  selected.includes(sc.id) ? "border-brand-500 bg-brand-50" : "border-[#E5E5E5] hover:border-[#D0D0D0]"
                }`}>
                  <input type="checkbox" checked={selected.includes(sc.id)}
                    onChange={() => toggleScenario(sc.id)} className="mt-0.5 accent-brand-500" />
                  <div>
                    <div className="text-[13px] font-semibold text-[#111]">{sc.label}</div>
                    <div className="text-[12px] text-[#888] mt-0.5 leading-snug">{sc.goal}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Options */}
          <div className="flex gap-3 mb-4">
            <div className="bg-white border border-[#EAEAEA] rounded-xl p-4 flex-1">
              <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                Runs per scenario
              </label>
              <input type="number" min={1} max={5} value={repeats}
                onChange={e => setRepeats(+e.target.value)}
                className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-brand-500" />
            </div>
            <div className="bg-white border border-[#EAEAEA] rounded-xl p-4 flex-1">
              <label className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] block mb-1.5">
                Max parallel
              </label>
              <input type="number" min={1} max={10} value={parallel}
                onChange={e => setParallel(+e.target.value)}
                className="w-20 border border-[#E5E5E5] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-brand-500" />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[13px] text-red-600 mb-4">{error}</div>
          )}

          <button onClick={handleRun} disabled={running}
            className="w-full flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[14px] rounded-xl py-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mb-8 shadow-sm">
            <Play className="w-4 h-4" />
            {running ? "Running simulations…" : "Run Simulations"}
          </button>

          {/* Stats + results */}
          {results.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-3 mb-6">
                <Stat label="Pass Rate" value={`${nPass}/${results.length} (${Math.round(100 * nPass / results.length)}%)`} />
                <Stat label="Avg Score" value={`${avgScore}/100`} />
                <Stat label="Avg Time"  value={`${(avgMs / 1000).toFixed(1)}s`} />
              </div>
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
                  Results ({results.length})
                </div>
                <button onClick={() => onResults([])}
                  className="flex items-center gap-1.5 text-[12px] text-[#888] hover:text-red-600 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" /> Clear
                </button>
              </div>
              {results.slice(0, 30).map((r, i) => (
                <SimResultCard key={`${r.scenario}-${r.patient_phone}-${i}`} result={r} defaultExpanded={false} />
              ))}
            </>
          )}
        </>
      )}

      {/* ══════════ MANUAL CHAT TAB ══════════ */}
      {subTab === "manual" && (
        <div>
          <div className="mb-4">
            <h2 className="text-[14px] font-bold text-[#111] mb-1">Manual SMS Chat</h2>
            <p className="text-[13px] text-[#888] leading-relaxed">
              Type as a patient — your messages go directly to the <strong>real Siriyaa SMS agent</strong> via the ADIT backend.
              Exactly what a real patient texting in would experience.
            </p>
            {!config.bearerToken && (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-[12.5px] text-amber-700">
                ⚠ Bearer token required in the sidebar to connect to the real agent.
              </div>
            )}
          </div>
          <ManualSMS config={{
            apiBase: config.apiBase,
            bearerToken: config.bearerToken,
            agentPhone: config.agentPhone,
          }} />
          <div className="mt-4 bg-[#F8F8F6] border border-[#EAEAEA] rounded-xl px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1.5">How it works</div>
            <div className="text-[12.5px] text-[#555] leading-relaxed space-y-1">
              <div>• Each conversation gets a unique patient phone number (auto-generated)</div>
              <div>• Messages proxy through <code className="bg-white border border-[#E5E5E5] rounded px-1 text-[11px]">/engage/forward-to-agent</code> — same endpoint real patients use</div>
              <div>• API events (booking called, patient lookup, etc.) appear as blue pills above each response</div>
              <div>• Hit <strong>New</strong> to start a fresh conversation with a new phone number</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
