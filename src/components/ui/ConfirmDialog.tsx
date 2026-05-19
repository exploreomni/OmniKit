import { useState, useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  itemCount?: number;
  requireTypedConfirmation?: boolean;
  confirmationPhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  itemCount,
  requireTypedConfirmation = false,
  confirmationPhrase = 'DELETE',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typedValue, setTypedValue] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      setTimeout(() => dialogRef.current?.focus(), 0);
    } else {
      setTypedValue('');
      previousFocusRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const needsTyped = requireTypedConfirmation || (variant === 'danger' && itemCount && itemCount >= 5);
  const isConfirmDisabled = needsTyped ? typedValue !== confirmationPhrase : false;
  const iconBg = variant === 'danger' ? 'bg-red-100' : 'bg-yellow-100';
  const iconColor = variant === 'danger' ? 'text-red-600' : 'text-yellow-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative bg-white rounded-card shadow-dropdown p-6 max-w-md w-full mx-4 animate-fadeIn outline-none"
      >
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 text-content-secondary hover:text-content-primary transition-colors"
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>

        <div className="flex items-start gap-3 mb-4">
          <div className={`flex-shrink-0 w-10 h-10 rounded-full ${iconBg} flex items-center justify-center`}>
            <AlertTriangle size={20} className={iconColor} />
          </div>
          <div>
            <h3 id="confirm-title" className="text-lg font-semibold text-content-primary">{title}</h3>
            <p className="text-sm text-content-secondary mt-1 leading-relaxed">
              {message}
              {itemCount != null && itemCount > 0 && (
                <span className="font-semibold text-content-primary"> ({itemCount} {itemCount === 1 ? 'item' : 'items'})</span>
              )}
            </p>
          </div>
        </div>

        {needsTyped && (
          <div className="mb-4 p-3 bg-surface-secondary rounded-card border border-border">
            <p className="text-xs text-content-secondary mb-2">
              Type <span className="font-mono font-semibold text-content-primary bg-white px-1.5 py-0.5 rounded border border-border">{confirmationPhrase}</span> to confirm
            </p>
            <input
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={confirmationPhrase}
              className="input-field text-sm font-mono"
              autoFocus
            />
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onCancel} className="btn-secondary text-sm">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isConfirmDisabled}
            className={variant === 'danger' ? 'btn-danger text-sm' : 'btn-primary text-sm'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
