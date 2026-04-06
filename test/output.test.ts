import { describe, expect, it } from 'vitest';

import { formatCycleResult } from '../src/output.js';

describe('formatCycleResult', () => {
  it('formats idle results compactly', () => {
    expect(formatCycleResult({ status: 'idle' })).toBe('idle');
  });

  it('formats completed results with job and summary', () => {
    expect(
      formatCycleResult({
        status: 'completed',
        jobId: 'job_123',
        detail: 'Applied requested changes'
      })
    ).toBe('completed job=job_123 summary="Applied requested changes"');
  });

  it('normalizes failed details into a single line', () => {
    expect(
      formatCycleResult({
        status: 'failed',
        jobId: 'job_123',
        detail: 'Control plane request failed\nwith status 401'
      })
    ).toBe('failed job=job_123 reason="Control plane request failed with status 401"');
  });

  it('formats cancelled results with reason', () => {
    expect(
      formatCycleResult({
        status: 'cancelled',
        jobId: 'job_123',
        detail: 'Cancelled by control plane'
      })
    ).toBe('cancelled job=job_123 reason="Cancelled by control plane"');
  });
});
