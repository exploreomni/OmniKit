import { RefreshCw } from 'lucide-react';
import { ComboBox } from '@/components/ui/ComboBox';
import type { DestinationFolderCatalog } from './useDashboardDestinationFolders';
import { destinationFolderChoices, destinationFolderPatch, destinationFolderSelection } from './dashboardDestinationSelection';

export function DestinationFolderPicker({ rowLabel, folderId, folderPath, disabled, catalog, onLoad, onChange }: {
  rowLabel: string;
  folderId?: string;
  folderPath?: string;
  disabled: boolean;
  catalog: DestinationFolderCatalog;
  onLoad: (forceRefresh?: boolean) => void;
  onChange: (value: { folderId: string; folderPath: string }) => void;
}) {
  const choices = destinationFolderChoices(catalog.folders);
  const selection = destinationFolderSelection(choices, { folderId, folderPath });
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-content-secondary">Folder</span>
        <button type="button" className="inline-flex items-center gap-1 text-xs text-content-secondary hover:text-content-primary disabled:opacity-50" aria-label={`Refresh ${rowLabel.toLowerCase()} folders`} onClick={() => onLoad(true)} disabled={disabled || catalog.loading}>
          <RefreshCw size={12} aria-hidden="true" />Refresh
        </button>
      </div>
      <ComboBox options={selection.options} value={selection.value} onChange={(value) => {
        const patch = destinationFolderPatch(choices, value);
        if (patch) onChange(patch);
      }} onOpen={() => onLoad()} allowFreeText={false} ariaLabel={`${rowLabel} folder`} disabled={disabled} isLoading={catalog.loading}
        loadingLabel="Loading destination folders…" placeholder="Search folders…" emptyLabel="No folders match your search" optionLayout="stacked" maxVisibleOptions={50} />
      {catalog.error ? <p role="alert" className="mt-1.5 text-xs text-red-700">{catalog.error} Use Refresh to try again.</p>
        : catalog.loaded && !catalog.complete ? <p role="status" className="mt-1.5 text-xs text-amber-800">Only part of the folder list was returned. Refresh or check instance access before relying on these choices.</p>
        : catalog.loaded && selection.missing ? <p role="status" className="mt-1.5 text-xs text-amber-800">Your current folder was not returned. It has been kept; select an available folder or refresh.</p>
        : <p className="mt-1.5 text-[11px] leading-4 text-content-tertiary">Search by folder name or path. Choose Top level to clear the folder. Readiness verifies your selection.</p>}
    </div>
  );
}
