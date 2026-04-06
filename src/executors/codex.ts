import { SkeletonExecutor } from './base.js';

export class CodexExecutor extends SkeletonExecutor {
  constructor(executionMode: 'dry-run' | 'strict') {
    super('codex', executionMode);
  }
}
