import { describe, expect, it } from 'vitest';
import { normaliseProgress } from '../../../src/tenancy/recovery/provider.js';

// Live envelope observed 2026-08-23 (job ia_mt5upiht11tnb3mkrh) after
// resume_automation_job {message:true, auto_save:true}: status flips to
// "done" but `step` keeps reading "user_approval".
const PUBLISHED_AT_GATE = {
  id: 'ia_live',
  status: 'done',
  step: 'user_approval',
  success: true,
  completed_steps: ['planner', 'code_fixer', 'step_preview_runner', 'user_approval', 'save_new_template'],
};

describe('normaliseProgress — publication precedence', () => {
  it('reports PUBLISHED when save_new_template is present even if step still says user_approval', () => {
    expect(normaliseProgress(PUBLISHED_AT_GATE).state).toBe('PUBLISHED');
  });
  it('reports APPROVED_NOT_SAVED when done at the gate without the save step', () => {
    expect(normaliseProgress({ ...PUBLISHED_AT_GATE, completed_steps: ['planner', 'user_approval'] }).state).toBe('APPROVED_NOT_SAVED');
  });
  it('reports AWAITING_APPROVAL while the gate is still pending', () => {
    expect(normaliseProgress({ ...PUBLISHED_AT_GATE, status: 'pending_answer', completed_steps: ['planner', 'user_approval'] }).state).toBe('AWAITING_APPROVAL');
  });
});
