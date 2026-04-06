export type JobMode = 'edit' | 'review' | 'build' | 'test' | 'unity_batch';
export type SessionPolicy = 'fresh' | 'prefer_reuse' | 'require_reuse';
export type SessionProvider = 'codex' | 'claude-code';
export type ArtifactKind =
  | 'stdout'
  | 'stderr'
  | 'patch'
  | 'diff'
  | 'screenshot'
  | 'build_output'
  | 'report'
  | 'archive';

export interface RemoteWorkerJob {
  job_id: string;
  workspace_key: string;
  repo_url: string;
  branch: string;
  base_commit: string;
  mode: JobMode;
  requirements: string[];
  prompt: string;
  target_files: string[];
  timeout_sec: number;
}

export interface AttemptLease {
  attempt_id: string;
  lease_token: string;
  heartbeat_interval_sec: number;
  lease_ttl_sec: number;
}

export interface SessionResume {
  provider: SessionProvider;
  opaque_session_id: string;
}

export interface SessionClaim {
  session_key?: string;
  session_policy: SessionPolicy;
  resume?: SessionResume | null;
}

export interface JobClaimResponse {
  job: RemoteWorkerJob;
  attempt: AttemptLease;
  session: SessionClaim;
}

export interface WorkerRegisterRequest {
  worker_id: string;
  display_name: string;
  capability_tokens: string[];
  max_concurrency: number;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerRegisterResponse {
  worker_id: string;
  status: string;
  heartbeat_interval_sec: number;
  lease_ttl_sec: number;
}

export interface WorkerHeartbeatRequest {
  status: 'idle' | 'busy' | 'draining';
  running_attempt_ids: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkerHeartbeatResponse {
  accepted: boolean;
  server_time: string;
  next_heartbeat_sec: number;
  drain_requested: boolean;
}

export interface AttemptStartRequest {
  worker_id: string;
  provider: SessionProvider;
  opaque_session_id?: string;
  session_reused: boolean;
}

export interface AttemptHeartbeatRequest {
  worker_id: string;
  progress_phase: string;
  progress_message?: string;
  session_touch?: boolean;
}

export interface AttemptHeartbeatResponse {
  accepted: boolean;
  lease_expires_at: string;
  cancel_requested: boolean;
  cancel_reason?: string;
  interrupt_deadline_at?: string;
}

export interface AttemptCompleteRequest {
  worker_id: string;
  result_summary: string;
  result_json?: Record<string, unknown>;
}

export interface AttemptFailRequest {
  worker_id: string;
  failure_code: string;
  failure_message: string;
  retryable: boolean;
  result_json?: Record<string, unknown>;
}

export interface AttemptCancelledRequest {
  worker_id: string;
  result_summary?: string;
  result_json?: Record<string, unknown>;
}

interface ArtifactBase {
  kind: ArtifactKind;
  content_type: string;
  sha256?: string;
  size_bytes?: number;
  metadata?: Record<string, unknown>;
}

export interface InlineArtifactUploadRequest extends ArtifactBase {
  storage_type: 'inline';
  content_base64: string;
}

export interface RemoteArtifactUploadRequest extends ArtifactBase {
  storage_type: 'remote_url';
  locator_url: string;
}

export type ArtifactUploadRequest = InlineArtifactUploadRequest | RemoteArtifactUploadRequest;

export interface JobStatusResponse {
  job: Record<string, unknown>;
  latest_attempt?: Record<string, unknown>;
  artifacts: Record<string, unknown>[];
  history_summary?: Record<string, unknown>;
  cancel_requested?: boolean;
}

export interface ExecutorArtifact {
  request: ArtifactUploadRequest;
}

export interface ExecutorRunResult {
  status: 'completed' | 'failed' | 'cancelled';
  result_summary: string;
  result_json?: Record<string, unknown>;
  failure_code?: string;
  failure_message?: string;
  opaque_session_id?: string;
  artifacts?: ExecutorArtifact[];
}
