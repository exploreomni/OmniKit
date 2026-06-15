import { type KeyboardEvent, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PassphraseInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  autoComplete?: string;
  className?: string;
  inputClassName?: string;
  onSubmit?: () => void;
}

export function PassphraseInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  autoComplete = 'current-password',
  className = '',
  inputClassName = '',
  onSubmit,
}: PassphraseInputProps) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  function updateCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState('CapsLock'));
  }

  return (
    <div className={className}>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            updateCapsLock(event);
            if (event.key === 'Enter' && onSubmit) onSubmit();
          }}
          onKeyUp={updateCapsLock}
          onBlur={() => setCapsLock(false)}
          disabled={disabled}
          className={`input-field pr-10 ${inputClassName}`}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={false}
          autoCapitalize="off"
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          disabled={disabled}
          className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-button text-content-secondary transition hover:bg-surface-secondary hover:text-content-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={visible ? 'Hide passphrase' : 'Show passphrase'}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {capsLock && (
        <div className="mt-1 text-[11px] font-medium text-amber-700">
          Caps Lock is on.
        </div>
      )}
    </div>
  );
}
