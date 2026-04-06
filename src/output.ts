import type { WorkerCycleResult } from './worker.js';

function formatDetail(detail: string): string {
  return JSON.stringify(detail.replace(/\s+/g, ' ').trim());
}

export function formatCycleResult(result: WorkerCycleResult): string {
  switch (result.status) {
    case 'idle':
      return 'idle';
    case 'completed':
      return [
        'completed',
        result.jobId ? `job=${result.jobId}` : null,
        result.detail ? `summary=${formatDetail(result.detail)}` : null
      ]
        .filter(Boolean)
        .join(' ');
    case 'failed':
      return [
        'failed',
        result.jobId ? `job=${result.jobId}` : null,
        result.detail ? `reason=${formatDetail(result.detail)}` : null
      ]
        .filter(Boolean)
        .join(' ');
    case 'cancelled':
      return [
        'cancelled',
        result.jobId ? `job=${result.jobId}` : null,
        result.detail ? `reason=${formatDetail(result.detail)}` : null
      ]
        .filter(Boolean)
        .join(' ');
    default: {
      const exhaustive: never = result.status;
      throw new Error(`Unhandled worker cycle status: ${exhaustive}`);
    }
  }
}
