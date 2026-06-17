import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { CheckCircle2, ChevronDown, Search } from 'lucide-react';
import { selectedRowClass, unselectedRowClass } from '@/components/ui/selectionStyles';
import {
  comboBoxEmptyText,
  filterComboBoxOptions,
  resolveComboBoxDisplay,
  type ComboBoxOption,
} from './comboBoxUtils';

interface ComboBoxProps {
  options: ComboBoxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowFreeText?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  emptyLabel?: string;
}

export function ComboBox({
  options,
  value,
  onChange,
  placeholder = 'Select or type...',
  allowFreeText = true,
  ariaLabel,
  disabled = false,
  emptyLabel = 'No options found',
}: ComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const filtered = filterComboBoxOptions(options, search);
  const { selectedLabel, showIdBelowLabel } = resolveComboBoxDisplay(options, value);
  const customValue = search.trim();
  const showCustomOption = allowFreeText && customValue && filtered.length === 0;

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [search]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const scrollToIndex = useCallback((index: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-combobox-option]');
    items[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  function handleSelect(val: string) {
    if (disabled) return;
    onChange(val);
    setIsOpen(false);
    setSearch('');
    setHighlightedIndex(-1);
  }

  function handleInputChange(val: string) {
    if (disabled) return;
    setSearch(val);
    if (!isOpen) setIsOpen(true);
    if (allowFreeText) {
      onChange(val);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = highlightedIndex < filtered.length - 1 ? highlightedIndex + 1 : 0;
      setHighlightedIndex(next);
      scrollToIndex(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = highlightedIndex > 0 ? highlightedIndex - 1 : filtered.length - 1;
      setHighlightedIndex(prev);
      scrollToIndex(prev);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
        handleSelect(filtered[highlightedIndex].value);
      } else if (search && allowFreeText) {
        onChange(search);
        setIsOpen(false);
        setSearch('');
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setSearch('');
      setHighlightedIndex(-1);
    }
  }

  function openMenu() {
    if (disabled) return;
    setIsOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`input-field flex items-center justify-between gap-2 ${
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
        }`}
        onClick={openMenu}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
          }
        }}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={ariaLabel || placeholder}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
      >
        {isOpen ? (
          <div className="flex items-center gap-2 flex-1">
            <Search size={14} className="text-content-secondary flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="bg-transparent outline-none flex-1 text-sm"
              aria-autocomplete="list"
              aria-label={ariaLabel || placeholder}
              disabled={disabled}
            />
          </div>
        ) : (
          <div className={`min-w-0 flex-1 ${value ? '' : 'text-content-secondary/60'}`}>
            <div className="text-sm text-content-primary truncate">
              {value ? selectedLabel : placeholder}
            </div>
            {value && showIdBelowLabel && (
              <div className="text-[10px] text-content-secondary/50 font-mono truncate">
                {value}
              </div>
            )}
          </div>
        )}
        <ChevronDown
          size={16}
          className={`text-content-secondary flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </div>

      {isOpen && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-50 w-full mt-1 bg-white border border-border rounded-button shadow-dropdown max-h-60 overflow-y-auto"
        >
          {filtered.length === 0 ? (
            showCustomOption ? (
              <button
                type="button"
                data-combobox-option
                onClick={() => handleSelect(customValue)}
                onMouseEnter={() => setHighlightedIndex(0)}
                role="option"
                aria-selected={customValue === value}
                className={`w-full text-left px-3 py-2 text-sm transition-all ${
                  customValue === value
                    ? selectedRowClass
                    : highlightedIndex === 0
                      ? 'border-l-4 border-l-omni-300 bg-omni-100 text-omni-700'
                      : unselectedRowClass
                }`}
              >
                Use "{customValue}" as custom value
              </button>
            ) : (
            <div className="px-3 py-2 text-sm text-content-secondary">
              {comboBoxEmptyText({ allowFreeText, search, emptyLabel })}
            </div>
            )
          ) : (
            filtered.map((option, index) => (
              <button
                key={`${option.value}:${index}`}
                data-combobox-option
                onClick={() => handleSelect(option.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
                role="option"
                aria-selected={option.value === value}
                className={`w-full text-left px-3 py-2 text-sm transition-all ${
                  option.value === value
                    ? selectedRowClass
                    : index === highlightedIndex
                      ? 'border-l-4 border-l-omni-300 bg-omni-100 text-omni-700'
                      : unselectedRowClass
                }`}
              >
                <div className="flex items-center gap-2">
                  {option.value === value && <CheckCircle2 size={13} className="shrink-0 text-omni-700" />}
                  <span className="truncate">{option.label}</span>
                  {option.subtitle && (
                    <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                      {option.subtitle}
                    </span>
                  )}
                </div>
                {option.label !== option.value && (
                  <div className="text-xs text-content-secondary font-mono truncate">{option.value}</div>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
