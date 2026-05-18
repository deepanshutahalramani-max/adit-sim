/**
 * RegisteredPatientCard — shows who's stored as the "existing patient" for
 * reschedule/cancel/existing-routine simulations.  Auto-populated after any
 * successful new-patient booking run; can also be set manually.
 */
import { useState } from "react";
import { UserCheck, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchRegisteredPatient, clearRegisteredPatient, setRegisteredPatient } from "../api";

export function RegisteredPatientCard() {
  const qc = useQueryClient();

  const { data: reg } = useQuery({
    queryKey: ["registeredPatient"],
    queryFn: fetchRegisteredPatient,
    staleTime: 10_000,
  });

  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState({ first_name: "", last_name: "", dob: "", insurance: "" });
  const [saving, setSaving]       = useState(false);

  const handleClear = async () => {
    await clearRegisteredPatient();
    qc.invalidateQueries({ queryKey: ["registeredPatient"] });
  };

  const handleSave = async () => {
    if (!form.first_name || !form.last_name || !form.dob) return;
    setSaving(true);
    try {
      await setRegisteredPatient(form);
      setShowForm(false);
      setForm({ first_name: "", last_name: "", dob: "", insurance: "" });
      qc.invalidateQueries({ queryKey: ["registeredPatient"] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-[#EAEAEA] rounded-xl p-4 mb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <UserCheck className="w-3.5 h-3.5 text-[#ADADAD]" />
          <span className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
            Registered Patient
          </span>
          <span className="text-[10px] font-normal text-[#ADADAD] normal-case">
            — existing-patient scenarios use these details
          </span>
        </div>
        {reg?.registered && (
          <button
            onClick={handleClear}
            className="text-[11px] text-[#ADADAD] hover:text-red-500 transition-colors flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Active patient */}
      {reg?.registered ? (
        <div className="flex items-center gap-3 bg-[#F0FDF4] border border-[#BBF7D0] rounded-lg px-3 py-2">
          <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center text-base flex-shrink-0">
            👤
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[#111]">
              {reg.first_name} {reg.last_name}
            </div>
            <div className="text-[11px] text-[#555]">
              DOB: {reg.dob}
              {reg.insurance ? ` · ${reg.insurance}` : ""}
            </div>
          </div>
          <span className="ml-auto flex-shrink-0 text-[10px] font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
            Active
          </span>
        </div>
      ) : (
        <div className="text-[11.5px] text-[#ADADAD] leading-relaxed">
          No patient registered. Run a <strong className="text-[#555]">new patient</strong> scenario and it
          auto-registers on success — or{" "}
          <button
            onClick={() => setShowForm(v => !v)}
            className="text-brand-500 underline hover:no-underline"
          >
            set manually
          </button>{" "}
          if you know who's in the system.
        </div>
      )}

      {/* Manual entry form */}
      {showForm && (
        <div className="mt-3 border border-[#E5E5E5] rounded-lg p-3 bg-[#FAFAF8] space-y-2">
          <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
            Register manually
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.first_name}
              onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
              placeholder="First name *"
              className="border border-[#E5E5E5] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-brand-400"
            />
            <input
              value={form.last_name}
              onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
              placeholder="Last name *"
              className="border border-[#E5E5E5] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-brand-400"
            />
          </div>
          <input
            value={form.dob}
            onChange={e => setForm(f => ({ ...f, dob: e.target.value }))}
            placeholder="Date of birth * (e.g. June 20, 1978)"
            className="w-full border border-[#E5E5E5] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-brand-400"
          />
          <input
            value={form.insurance}
            onChange={e => setForm(f => ({ ...f, insurance: e.target.value }))}
            placeholder="Insurance (optional)"
            className="w-full border border-[#E5E5E5] rounded-lg px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-brand-400"
          />
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || !form.first_name || !form.last_name || !form.dob}
              className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-[12px] font-semibold rounded-lg py-1.5 transition-colors"
            >
              {saving ? "Saving…" : "Register"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="flex-1 border border-[#E5E5E5] text-[#888] text-[12px] rounded-lg py-1.5 hover:border-[#ADADAD]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
