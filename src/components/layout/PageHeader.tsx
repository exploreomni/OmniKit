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
    <div className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        {icon && (
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 overflow-visible"
            style={{
              background: '#FFFFFF',
              border: '1px solid rgba(217,222,232,0.95)',
              color: '#C83B70',
            }}
          >
            {icon}
          </div>
        )}
        <div className="min-w-0 pt-0.5">
          <h1
            className={`text-2xl font-bold leading-tight tracking-tight break-words ${
              gradient ? 'gradient-text' : 'text-content-primary'
            }`}
          >
            {title}
          </h1>
          {description && (
            <p className="text-[13px] leading-5 text-content-secondary mt-1.5 max-w-3xl">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:gap-3 lg:w-auto lg:justify-end lg:pl-6">
          {actions}
        </div>
      )}
    </div>
  );
}
