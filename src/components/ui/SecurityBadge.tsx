import { ShieldCheck } from 'lucide-react';

export function SecurityBadge() {
  return (
    <div className="bg-green-50 border border-green-200 text-green-700 rounded-card px-3.5 py-2 text-xs font-medium inline-flex items-center gap-2">
      <ShieldCheck size={14} className="flex-shrink-0" />
      <span>No data is stored. Credentials are used only in your active browser session.</span>
    </div>
  );
}
