import { useState } from 'react';
import { dashboardPackageBindingKey, type DashboardPackageBindingMapping, type DashboardPackageBindingNamespace } from '../../../shared/dashboardPackageBindings';

function label(binding: DashboardPackageBindingNamespace) {
  return (['catalog', 'database', 'schema'] as const).filter(key => binding[key] !== undefined)
    .map(key => `${key}: ${binding[key]}`).join(' · ') || 'Connection defaults';
}

/** Consent changes the saved plan only. It never dispatches a model write. */
export function DashboardPackageBindingChoices({ mappings, approved, reviewed, disabled, onSave }: {
  mappings: DashboardPackageBindingMapping[]; approved: DashboardPackageBindingMapping[];
  reviewed: boolean; disabled: boolean; onSave: (mappings: DashboardPackageBindingMapping[]) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  if (!mappings.length && !approved.length) return null;
  const matches = mappings.length > 0 && mappings.length === approved.length
    && mappings.every(mapping => approved.some(row => dashboardPackageBindingKey(row) === dashboardPackageBindingKey(mapping)));
  return <section aria-label="Database and schema choice" className="rounded-card border border-border bg-white p-4 space-y-3">
    <h4 className="text-sm font-semibold text-content-primary">Use destination database/schema</h4>
    <p className="text-xs leading-5 text-content-secondary">Keep the existing destination locations for these matching table-backed views. Table names, formulas, joins, and access rules are not remapped. Only compatible missing definitions can be added. This does not verify warehouse data equivalence.</p>
    {mappings.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <thead><tr className="border-b border-border"><th className="p-2">View</th><th className="p-2">Source</th><th className="p-2">Keep destination</th></tr></thead>
      <tbody>{mappings.map(mapping => <tr key={dashboardPackageBindingKey(mapping)} className="border-b border-border align-top">
        <th className="p-2 font-medium break-all" scope="row">{mapping.targetFileName}</th>
        <td className="p-2 break-words">{label(mapping.source)}</td><td className="p-2 break-words">{label(mapping.destination)}</td>
      </tr>)}</tbody>
    </table></div>}
    {matches ? <p className="text-xs leading-5 text-content-secondary">These exact bindings are saved in this plan. Recheck readiness and review the refreshed package before selecting the destination.</p>
      : mappings.length > 0 && <>
        <label className="flex items-start gap-3 text-xs leading-5 text-content-secondary"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-omni-600"
          disabled={disabled || !reviewed} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I approve using the listed destination database/schema for these {mappings.length} views.</label>
        <button type="button" className="btn-primary btn-sm" disabled={disabled || !reviewed || !confirmed} onClick={() => { setConfirmed(false); onSave(mappings); }}>Save database/schema choice</button>
        {!reviewed && <p className="text-xs text-content-secondary">Load and review package details above to enable this choice.</p>}
      </>}
    {approved.length > 0 && <button type="button" className="btn-secondary btn-sm" disabled={disabled} onClick={() => { setConfirmed(false); onSave([]); }}>Clear saved database/schema choices</button>}
    <p className="text-xs text-content-tertiary">Saving or clearing this choice changes only the plan, invalidates readiness, and never deploys anything.</p>
  </section>;
}
