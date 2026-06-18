export interface ComboBoxOption {
  value: string;
  label: string;
  subtitle?: string;
}

export function filterComboBoxOptions(options: ComboBoxOption[], search: string): ComboBoxOption[] {
  const query = search.trim().toLowerCase();
  if (!query) return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(query) ||
      option.value.toLowerCase().includes(query) ||
      option.subtitle?.toLowerCase().includes(query)
  );
}

export function resolveComboBoxDisplay(options: ComboBoxOption[], value: string) {
  const selectedOption = options.find((option) => option.value === value);
  return {
    selectedLabel: selectedOption?.label || value,
    showIdBelowLabel: Boolean(selectedOption && selectedOption.label !== selectedOption.value),
  };
}

export function comboBoxEmptyText({
  allowFreeText,
  search,
  emptyLabel,
}: {
  allowFreeText: boolean;
  search: string;
  emptyLabel: string;
}): string {
  return allowFreeText && search ? `Use "${search}" as custom value` : emptyLabel;
}
