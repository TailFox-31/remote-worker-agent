import { SkeletonExecutor } from './base.js';

export class ClaudeCodeExecutor extends SkeletonExecutor {
  constructor(executionMode: 'dry-run' | 'strict') {
    super('claude-code', executionMode);
  }
}
