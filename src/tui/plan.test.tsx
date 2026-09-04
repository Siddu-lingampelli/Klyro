import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PlanView } from './plan.js';
import type { PlanStep } from '../agent/runtime.js';

const sampleSteps: PlanStep[] = [
  { id: '1', title: 'read src/foo.ts', status: 'done' },
  { id: '2', title: 'edit src/foo.ts', status: 'in_progress', files: ['src/foo.ts'] },
  { id: '3', title: 'run tests', status: 'pending' },
];

describe('PlanView', () => {
  it('returns null when there are no steps', () => {
    const { lastFrame } = render(<PlanView steps={[]} expanded onToggle={() => {}} />);
    expect(lastFrame()).toBe('');
  });

  it('renders the in-progress step when collapsed', () => {
    const { lastFrame } = render(<PlanView steps={sampleSteps} expanded={false} onToggle={() => {}} />);
    const out = lastFrame();
    expect(out).toContain('edit src/foo.ts');
    expect(out).toContain('[1/3]');
    expect(out).toContain('/plan');
  });

  it('renders all steps with status glyphs when expanded', () => {
    const { lastFrame } = render(<PlanView steps={sampleSteps} expanded onToggle={() => {}} />);
    const out = lastFrame();
    expect(out).toContain('read src/foo.ts');
    expect(out).toContain('edit src/foo.ts');
    expect(out).toContain('run tests');
    expect(out).toContain('1/3');
    expect(out).toContain('Plan');
  });

  it('shows failure glyphs for failed steps', () => {
    const steps: PlanStep[] = [
      { id: '1', title: 'do thing', status: 'failed' },
    ];
    const { lastFrame } = render(<PlanView steps={steps} expanded onToggle={() => {}} />);
    expect(lastFrame()).toContain('✗');
  });

  it('shows the files list for in-progress steps', () => {
    const { lastFrame } = render(<PlanView steps={sampleSteps} expanded onToggle={() => {}} />);
    expect(lastFrame()).toContain('src/foo.ts');
  });
});
