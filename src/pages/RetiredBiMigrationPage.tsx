import { ArrowLeft, GitBranch, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';

export function RetiredBiMigrationPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="BI Migration Studio retired"
        description="The source-to-Omni BI migration workflow is no longer part of OmniKit."
      />

      <section className="card max-w-3xl p-6">
        <p className="text-sm leading-relaxed text-content-secondary">
          OmniKit continues to provide Dashboard Migrator, Model Migrator, and AI Semantic Studio.
          Existing BI Migration Studio bookmarks are retained temporarily only to explain the change;
          they do not load source connectors, credentials, migration jobs, or the former migration engine.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link className="btn-secondary" to="/">
            <ArrowLeft size={15} aria-hidden="true" />
            Return home
          </Link>
          <Link className="btn-primary" to="/models/migrate">
            <GitBranch size={15} aria-hidden="true" />
            Open Omni-to-Omni Model Migrator
          </Link>
          <Link className="btn-secondary" to="/data-privacy">
            <ShieldCheck size={15} aria-hidden="true" />
            Review retired local data
          </Link>
        </div>
      </section>
    </div>
  );
}
