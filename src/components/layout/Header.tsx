import { LayoutDashboard } from 'lucide-react';
import { SecurityBadge } from '@/components/ui/SecurityBadge';

export function Header() {
  return (
    <header className="bg-omni-900 text-white h-14 flex items-center px-6 justify-between flex-shrink-0">
      <div className="flex items-center gap-3">
        <LayoutDashboard size={22} className="text-omni-500" />
        <h1 className="text-base font-semibold tracking-tight">Dashboard Migration Tool</h1>
      </div>
      <SecurityBadge />
    </header>
  );
}
