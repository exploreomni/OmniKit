import { useMemo, useState } from 'react';
import { BookOpen, Download, ExternalLink, GraduationCap } from 'lucide-react';
import { Link } from 'react-router';

import { PageHeader } from '@/components/layout/PageHeader';
import {
  ENABLEMENT_ROLES,
  generateRoleEnablementPath,
  roleEnablementMarkdown,
  type EnablementDepth,
  type EnablementGoal,
  type EnablementRole,
} from '@/services/roleEnablement';

const GOALS: Array<{ id: EnablementGoal; label: string }> = [
  { id: 'consume', label: 'Consume trusted content' },
  { id: 'explore', label: 'Explore data' },
  { id: 'build', label: 'Build content' },
  { id: 'govern', label: 'Govern releases' },
  { id: 'administer', label: 'Administer Omni' },
  { id: 'ai', label: 'Use AI safely' },
];

function downloadPath(markdown: string, role: EnablementRole): void {
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `omnikit-${role.toLowerCase().replace(/\s+/g, '-')}-enablement.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function RoleEnablementPage() {
  const [role, setRole] = useState<EnablementRole>('Viewer');
  const [depth, setDepth] = useState<EnablementDepth>('core');
  const [goals, setGoals] = useState<EnablementGoal[]>([]);
  const path = useMemo(() => generateRoleEnablementPath({ role, depth, goals }), [depth, goals, role]);

  function toggleGoal(goal: EnablementGoal): void {
    setGoals((current) => current.includes(goal) ? current.filter((item) => item !== goal) : [...current, goal]);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Role-Based Enablement"
        description="Generate a practical learning path from OmniKit’s existing walkthrough, app, and deck workflows. This creates reusable enablement—not a separate LMS or a permission assignment."
        icon={<GraduationCap size={46} className="text-omni-700" />}
        actions={(
          <button type="button" className="btn-secondary text-sm" onClick={() => downloadPath(roleEnablementMarkdown(path), role)} disabled={path.modules.length === 0}>
            <Download size={14} /> Export Markdown
          </button>
        )}
      />

      <section className="card p-5">
        <div className="grid gap-4 lg:grid-cols-3">
          <div>
            <label htmlFor="enablement-role" className="text-xs font-semibold text-content-primary">Omni role</label>
            <select id="enablement-role" className="input-field mt-1.5" value={role} onChange={(event) => setRole(event.target.value as EnablementRole)}>
              {ENABLEMENT_ROLES.map((item) => <option key={item}>{item}</option>)}
            </select>
            {role === 'Restricted Querier' && <p className="mt-1.5 text-[11px] leading-4 text-content-secondary">The learner-facing label is retained; the path explicitly teaches the Query Topics access boundary.</p>}
          </div>
          <div>
            <label htmlFor="enablement-depth" className="text-xs font-semibold text-content-primary">Depth</label>
            <select id="enablement-depth" className="input-field mt-1.5" value={depth} onChange={(event) => setDepth(event.target.value as EnablementDepth)}>
              <option value="quick_start">Quick start</option>
              <option value="core">Core path</option>
              <option value="deep_dive">Deep dive</option>
            </select>
          </div>
          <div>
            <div className="text-xs font-semibold text-content-primary">Estimated guided time</div>
            <div className="mt-2 text-2xl font-semibold text-content-primary">{path.totalMinutes} min</div>
            <p className="mt-1 text-xs text-content-secondary">{path.modules.length} reusable learning modules</p>
          </div>
        </div>

        <fieldset className="mt-5">
          <legend className="text-xs font-semibold text-content-primary">Optional focus areas</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {GOALS.map((goal) => (
              <label key={goal.id} className={`inline-flex cursor-pointer items-center gap-2 rounded-chip border px-3 py-2 text-xs ${goals.includes(goal.id) ? 'border-omni-300 bg-omni-50 text-omni-800' : 'border-border bg-white text-content-secondary'}`}>
                <input type="checkbox" className="accent-omni-700" checked={goals.includes(goal.id)} onChange={() => toggleGoal(goal.id)} />
                {goal.label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="card p-4 md:col-span-2">
          <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">Generated path</div>
          <h2 className="mt-2 text-lg font-semibold text-content-primary">{path.omniRoleLabel}</h2>
          <p className="mt-1 text-xs text-content-secondary">Role-specific practice with explicit proof and escalation boundaries.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">Prerequisites</div>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-content-secondary">{path.prerequisites.map((item) => <li key={item}>• {item}</li>)}</ul>
        </div>
      </div>

      {path.modules.length === 0 ? (
        <div className="card p-8 text-center text-sm text-content-secondary">No module matches every selected focus area. Clear a focus filter to broaden the path.</div>
      ) : (
        <ol className="space-y-3">
          {path.modules.map((module, index) => (
            <li key={module.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-omni-100 text-sm font-semibold text-omni-800">{index + 1}</div>
                  <div>
                    <h3 className="text-sm font-semibold text-content-primary">{module.title}</h3>
                    <p className="mt-1 text-xs leading-5 text-content-secondary">{module.objective}</p>
                  </div>
                </div>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-[11px] font-semibold text-content-secondary">{module.minutes} min</span>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                <div className="rounded-card border border-border bg-surface-secondary px-3 py-3 text-xs leading-5 text-content-secondary"><span className="font-semibold text-content-primary">Exercise</span><br />{module.exercise}</div>
                <div className="rounded-card border border-border bg-surface-secondary px-3 py-3 text-xs leading-5 text-content-secondary"><span className="font-semibold text-content-primary">Proof</span><br />{module.proof}</div>
                <div className="rounded-card border border-border bg-surface-secondary px-3 py-3 text-xs leading-5 text-content-secondary"><span className="font-semibold text-content-primary">Escalate when</span><br />{module.escalationBoundary}</div>
              </div>
              <div className="mt-3 flex justify-end">
                <Link to={module.asset.route} className="inline-flex min-h-10 items-center gap-1.5 rounded-button px-3 py-2 text-xs font-semibold text-omni-700 hover:bg-omni-50">
                  {module.asset.kind === 'deck' ? <BookOpen size={14} /> : <ExternalLink size={14} />}
                  Open {module.asset.label}
                </Link>
              </div>
            </li>
          ))}
        </ol>
      )}

      <section className="card p-4">
        <div className="text-sm font-semibold text-content-primary">Success measures and boundaries</div>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <ul className="space-y-1 text-xs leading-5 text-content-secondary">{path.successMeasures.map((item) => <li key={item}>• {item}</li>)}</ul>
          <ul className="space-y-1 text-xs leading-5 text-content-secondary">{path.guardrails.map((item) => <li key={item}>• {item}</li>)}</ul>
        </div>
      </section>
    </div>
  );
}
