import type {
  ArtifactUploadRequest,
  AttemptCancelledRequest,
  AttemptCompleteRequest,
  AttemptFailRequest,
  AttemptHeartbeatRequest,
  AttemptHeartbeatResponse,
  AttemptStartRequest,
  JobClaimResponse,
  JobStatusResponse,
  WorkerHeartbeatRequest,
  WorkerHeartbeatResponse,
  WorkerRegisterRequest,
  WorkerRegisterResponse
} from './types.js';

export class ControlPlaneHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Control plane request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

type FetchLike = typeof fetch;

export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async registerWorker(input: WorkerRegisterRequest): Promise<WorkerRegisterResponse> {
    return this.requestJson<WorkerRegisterResponse>('/v1/workers/register', {
      method: 'POST',
      body: input
    });
  }

  async heartbeatWorker(workerId: string, input: WorkerHeartbeatRequest): Promise<WorkerHeartbeatResponse> {
    return this.requestJson<WorkerHeartbeatResponse>(`/v1/workers/${workerId}/heartbeat`, {
      method: 'POST',
      body: input
    });
  }

  async setWorkerDrain(workerId: string, enabled: boolean): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>(`/v1/workers/${workerId}/drain`, {
      method: 'POST',
      body: { enabled }
    });
  }

  async claimJob(workerId: string): Promise<JobClaimResponse | null> {
    return this.requestJson<JobClaimResponse>(`/v1/jobs/claim`, {
      method: 'POST',
      body: { worker_id: workerId },
      allowNoContent: true
    });
  }

  async startAttempt(attemptId: string, leaseToken: string, input: AttemptStartRequest): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>(`/v1/attempts/${attemptId}/start`, {
      method: 'POST',
      body: input,
      leaseToken
    });
  }

  async heartbeatAttempt(
    attemptId: string,
    leaseToken: string,
    input: AttemptHeartbeatRequest
  ): Promise<AttemptHeartbeatResponse> {
    return this.requestJson<AttemptHeartbeatResponse>(`/v1/attempts/${attemptId}/heartbeat`, {
      method: 'POST',
      body: input,
      leaseToken
    });
  }

  async completeAttempt(
    attemptId: string,
    leaseToken: string,
    input: AttemptCompleteRequest
  ): Promise<{ job_status: string }> {
    return this.requestJson<{ job_status: string }>(`/v1/attempts/${attemptId}/complete`, {
      method: 'POST',
      body: input,
      leaseToken
    });
  }

  async failAttempt(attemptId: string, leaseToken: string, input: AttemptFailRequest): Promise<{ job_status: string }> {
    return this.requestJson<{ job_status: string }>(`/v1/attempts/${attemptId}/fail`, {
      method: 'POST',
      body: input,
      leaseToken
    });
  }

  async cancelAttempt(
    attemptId: string,
    leaseToken: string,
    input: AttemptCancelledRequest
  ): Promise<{ job_status: string }> {
    return this.requestJson<{ job_status: string }>(`/v1/attempts/${attemptId}/cancelled`, {
      method: 'POST',
      body: input,
      leaseToken
    });
  }

  async uploadArtifact(
    attemptId: string,
    leaseToken: string,
    input: ArtifactUploadRequest
  ): Promise<{ artifact_id: string }> {
    return this.requestJson<{ artifact_id: string }>(`/v1/attempts/${attemptId}/artifacts`, {
      method: 'POST',
      body: input,
      leaseToken
    });
  }

  async getJob(jobId: string): Promise<JobStatusResponse> {
    return this.requestJson<JobStatusResponse>(`/v1/jobs/${jobId}`, {
      method: 'GET'
    });
  }

  private async requestJson<T>(
    pathname: string,
    options: {
      method: string;
      body?: unknown;
      leaseToken?: string;
      allowNoContent: true;
    }
  ): Promise<T | null>;
  private async requestJson<T>(
    pathname: string,
    options: {
      method: string;
      body?: unknown;
      leaseToken?: string;
      allowNoContent?: false | undefined;
    }
  ): Promise<T>;
  private async requestJson<T>(
    pathname: string,
    options: {
      method: string;
      body?: unknown;
      leaseToken?: string;
      allowNoContent?: boolean;
    }
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`
    };

    if (options.leaseToken) {
      headers['x-lease-token'] = options.leaseToken;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: options.method,
      headers,
      body
    });

    if (response.status === 204 && options.allowNoContent) {
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new ControlPlaneHttpError(response.status, payload);
    }

    return payload as T;
  }
}
