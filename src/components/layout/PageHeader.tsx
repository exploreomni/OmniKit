import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  gradient?: boolean;
}

export function PageHeader({ title, description, actions, icon, gradient = false }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-7">
      <div className="flex items-center gap-3.5">
        {icon && (
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: 'rgba(255,71,148,0.1)',
              border: '1px solid rgba(255,71,148,0.2)',
              color: '#C8186A',
            }}
          >
            {icon}
          </div>
        )}
        <div>
          <h1
            className={`text-2xl font-bold leading-tight tracking-tight ${
              gradient ? 'gradient-text' : 'text-content-primary'
            }`}
          >
            {title}
          </h1>
          {description && (
            <p className="text-[13px] text-content-secondary mt-1.5 leading-relaxed">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-3 flex-shrink-0 ml-6">{actions}</div>
      )}
    </div>
  );
}
