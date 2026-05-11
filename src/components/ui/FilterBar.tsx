import { SearchInput } from './SearchInput';

export interface FilterConfig {
  key: string;
  label: string;
  type: 'search' | 'select' | 'toggle';
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
}

interface FilterBarProps {
  filters: FilterConfig[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export function FilterBar({ filters, values, onChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap gap-3 items-end">
      {filters.map((filter) => {
        if (filter.type === 'search') {
          return (
            <div key={filter.key} className="flex-1 min-w-[200px]">
              <SearchInput
                value={values[filter.key] || ''}
                onChange={(v) => onChange(filter.key, v)}
                placeholder={filter.placeholder || `Search ${filter.label.toLowerCase()}...`}
              />
            </div>
          );
        }

        if (filter.type === 'select') {
          return (
            <div key={filter.key} className="min-w-[140px]">
              <label className="block text-[10px] font-medium text-content-secondary uppercase tracking-wider mb-1">
                {filter.label}
              </label>
              <select
                value={values[filter.key] || ''}
                onChange={(e) => onChange(filter.key, e.target.value)}
                className="input-field text-sm"
              >
                <option value="">All</option>
                {filter.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (filter.type === 'toggle') {
          return (
            <div key={filter.key} className="flex items-center gap-2 pb-1">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={values[filter.key] === 'true'}
                  onChange={(e) => onChange(filter.key, e.target.checked ? 'true' : '')}
                  className="sr-only peer"
                />
                <div className="w-8 h-4 bg-gray-200 peer-focus:ring-2 peer-focus:ring-omni-500/40 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-omni-700" />
              </label>
              <span className="text-xs text-content-secondary">{filter.label}</span>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
