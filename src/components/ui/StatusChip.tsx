import type { MigrationItemStatus } from '@/types';

const variants: Record<string, string> = {
  success: 'bg-green-100 text-green-800',
  ready: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  failed: 'bg-red-100 text-red-800',
  warning: 'bg-yellow-100 text-yellow-800',
  skipped: 'bg-yellow-100 text-yellow-800',
  info: 'bg-blue-100 text-blue-800',
  pending: 'bg-gray-100 text-gray-600',
  in_progress: 'bg-blue-100 text-blue-800',
};

const labels: Record<string, string> = {
  success: 'Success',
  ready: 'Ready',
  error: 'Error',
  failed: 'Failed',
  warning: 'Warning',
  skipped: 'Skipped',
  info: 'Info',
  pending: 'Pending',
  in_progress: 'In Progress',
};

interface StatusChipProps {
  status: MigrationItemStatus | string;
  label?: string;
}

export function StatusChip({ status, label }: StatusChipProps) {
  const classes = variants[status] || variants.info;
  const text = label || labels[status] || status;

  return (
    <span className={`${classes} rounded-chip px-2.5 py-0.5 text-xs font-medium inline-flex items-center gap-1`}>
      {text}
    </span>
  );
}
