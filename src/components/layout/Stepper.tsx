import { Check } from 'lucide-react';
import { STEP_LABELS } from '@/types';
import type { WizardStep } from '@/types';

interface StepperProps {
  currentStep: WizardStep;
}

export function Stepper({ currentStep }: StepperProps) {
  return (
    <div className="flex items-center justify-center py-8 px-4">
      {STEP_LABELS.map((label, index) => {
        const isActive = index === currentStep;
        const isCompleted = index < currentStep;

        return (
          <div key={label} className="flex items-center">
            <div className="flex items-center gap-2.5 relative">
              {isActive && (
                <img
                  src="/blobby-face.webp"
                  alt=""
                  className="absolute -top-9 left-1 w-6 h-6 object-contain animate-float pointer-events-none"
                  style={{ animationDuration: '2.5s' }}
                />
              )}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 ${
                  isCompleted
                    ? 'text-white'
                    : isActive
                    ? 'text-white animate-stepPulse'
                    : 'text-content-tertiary'
                }`}
                style={
                  isCompleted
                    ? {
                        background: 'linear-gradient(135deg, #D41A6E 0%, #E63D82 100%)',
                        boxShadow: '0 2px 8px rgba(212,26,110,0.3)',
                      }
                    : isActive
                    ? {
                        background: 'linear-gradient(135deg, #D41A6E 0%, #E63D82 100%)',
                        boxShadow: '0 2px 12px rgba(212,26,110,0.4)',
                      }
                    : {
                        background: 'rgba(107,16,56,0.08)',
                        border: '1.5px solid rgba(242,206,220,0.8)',
                      }
                }
              >
                {isCompleted ? <Check size={15} strokeWidth={2.5} /> : index + 1}
              </div>
              <span
                className={`text-sm hidden sm:inline transition-colors duration-200 font-medium ${
                  isActive
                    ? 'text-omni-700 font-semibold'
                    : isCompleted
                    ? 'text-content-primary'
                    : 'text-content-tertiary'
                }`}
              >
                {label}
              </span>
            </div>

            {index < STEP_LABELS.length - 1 && (
              <div
                className="w-8 sm:w-16 h-0.5 mx-2 sm:mx-3 rounded-full overflow-hidden"
                style={{ background: 'rgba(242,206,220,0.8)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: index < currentStep ? '100%' : index === currentStep ? '50%' : '0%',
                    background:
                      index < currentStep
                        ? 'linear-gradient(90deg, #D41A6E 0%, #E63D82 100%)'
                        : 'linear-gradient(90deg, #FF7DB3 0%, #FFB0D0 100%)',
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
