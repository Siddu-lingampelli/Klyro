/**
 * Status snapshot — session state pushed from app.tsx via hooks.
 *
 * NOTE: the old StatusLine component was removed: App renders its own
 * status row inline, and the standalone component's tests gave false
 * coverage for UI nobody sees.
 */

export interface StatusSnapshot {
  model: string;
  step: number;
  maxSteps: number;
  usageInput: number;
  usageOutput: number;
  repairs: number;
  status: 'idle' | 'running' | 'done' | 'error' | 'aborted';
  errorMessage?: string;
}
