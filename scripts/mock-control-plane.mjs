#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import process from 'node:process';

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix, index) {
  return `${prefix}-${index}`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  sendJson(response, 404, { error: 'not_found' });
}

function unauthorized(response) {
  sendJson(response, 401, { error: 'unauthorized' });
}

function badRequest(response, message) {
  sendJson(response, 400, { error: 'bad_request', message });
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

const port = Number.parseInt(process.env.MOCK_CONTROL_PLANE_PORT ?? '8787', 10);
const token = process.env.MOCK_CONTROL_PLANE_TOKEN ?? 'ci-token';
const stateFile = process.env.MOCK_STATE_FILE;
const repoUrl = process.env.MOCK_JOB_REPO_URL;
const baseCommit = process.env.MOCK_JOB_BASE_COMMIT;

if (!repoUrl || !baseCommit) {
  console.error('MOCK_JOB_REPO_URL and MOCK_JOB_BASE_COMMIT are required.');
  process.exit(1);
}

const job = {
  job_id: process.env.MOCK_JOB_ID ?? 'job-ci-smoke-1',
  workspace_key: process.env.MOCK_JOB_WORKSPACE_KEY ?? 'repo:ci-smoke',
  repo_url: repoUrl,
  branch: process.env.MOCK_JOB_BRANCH ?? 'main',
  base_commit: baseCommit,
  mode: 'edit',
  requirements: (process.env.MOCK_JOB_REQUIREMENTS ?? 'tool:codex,tool:git,os:windows')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  prompt:
    process.env.MOCK_JOB_PROMPT ??
    'Open README.md, append a single new line that says `CI smoke executed.` and then stop. Keep all other content unchanged.',
  target_files: (process.env.MOCK_JOB_TARGET_FILES ?? 'README.md')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  timeout_sec: 600,
  status: 'queued',
  assigned_worker_id: null,
};

const attempt = {
  attempt_id: process.env.MOCK_ATTEMPT_ID ?? 'att-ci-smoke-1',
  lease_token: process.env.MOCK_LEASE_TOKEN ?? 'lease-ci-smoke-1',
  heartbeat_interval_sec: 1,
  lease_ttl_sec: 30,
  status: 'claimed',
  worker_id: null,
  started_at: null,
  finished_at: null,
  last_heartbeat_at: null,
  result_summary: null,
  result_json: null,
  failure_code: null,
  failure_message: null,
};

const state = {
  job,
  latestAttempt: null,
  artifacts: [],
  workers: {},
  claimServed: false,
};

function persistState() {
  if (!stateFile) {
    return;
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

persistState();

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const path = requestUrl.pathname;
  const method = request.method ?? 'GET';

  if (method === 'GET' && path === '/__state') {
    sendJson(response, 200, state);
    return;
  }

  const authHeader = request.headers.authorization;
  if (authHeader !== `Bearer ${token}`) {
    unauthorized(response);
    return;
  }

  try {
    if (method === 'POST' && path === '/v1/workers/register') {
      const body = await parseBody(request);
      if (!body.worker_id) {
        badRequest(response, 'worker_id is required');
        return;
      }
      state.workers[body.worker_id] = {
        worker_id: body.worker_id,
        display_name: body.display_name,
        capability_tokens: body.capability_tokens,
        last_heartbeat_at: nowIso(),
      };
      persistState();
      sendJson(response, 200, {
        worker_id: body.worker_id,
        status: 'registered',
        heartbeat_interval_sec: 1,
        lease_ttl_sec: 30,
      });
      return;
    }

    const workerHeartbeatMatch = path.match(/^\/v1\/workers\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && workerHeartbeatMatch) {
      const workerId = decodeURIComponent(workerHeartbeatMatch[1]);
      const body = await parseBody(request);
      state.workers[workerId] = {
        ...(state.workers[workerId] ?? { worker_id: workerId }),
        status: body.status,
        running_attempt_ids: body.running_attempt_ids,
        last_heartbeat_at: nowIso(),
      };
      persistState();
      sendJson(response, 200, {
        accepted: true,
        server_time: nowIso(),
        next_heartbeat_sec: 1,
        drain_requested: false,
      });
      return;
    }

    if (method === 'POST' && path === '/v1/jobs/claim') {
      const body = await parseBody(request);
      if (state.claimServed) {
        response.writeHead(204);
        response.end();
        return;
      }

      state.claimServed = true;
      state.job.status = 'claimed';
      state.job.assigned_worker_id = body.worker_id;
      attempt.worker_id = body.worker_id;
      attempt.status = 'claimed';
      attempt.last_heartbeat_at = nowIso();
      state.latestAttempt = { ...attempt };
      persistState();

      sendJson(response, 200, {
        job: {
          job_id: state.job.job_id,
          workspace_key: state.job.workspace_key,
          repo_url: state.job.repo_url,
          branch: state.job.branch,
          base_commit: state.job.base_commit,
          mode: state.job.mode,
          requirements: state.job.requirements,
          prompt: state.job.prompt,
          target_files: state.job.target_files,
          timeout_sec: state.job.timeout_sec,
        },
        attempt: {
          attempt_id: attempt.attempt_id,
          lease_token: attempt.lease_token,
          heartbeat_interval_sec: attempt.heartbeat_interval_sec,
          lease_ttl_sec: attempt.lease_ttl_sec,
        },
        session: {
          session_policy: 'fresh',
          resume: null,
        },
      });
      return;
    }

    const requireLease = () => {
      if (request.headers['x-lease-token'] !== attempt.lease_token) {
        unauthorized(response);
        return false;
      }
      return true;
    };

    const attemptStartMatch = path.match(/^\/v1\/attempts\/([^/]+)\/start$/);
    if (method === 'POST' && attemptStartMatch) {
      if (!requireLease()) {
        return;
      }
      const body = await parseBody(request);
      attempt.status = 'running';
      attempt.started_at = nowIso();
      attempt.last_heartbeat_at = nowIso();
      attempt.worker_id = body.worker_id;
      state.job.status = 'running';
      state.latestAttempt = { ...attempt };
      persistState();
      sendJson(response, 200, { status: 'running' });
      return;
    }

    const attemptHeartbeatMatch = path.match(/^\/v1\/attempts\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && attemptHeartbeatMatch) {
      if (!requireLease()) {
        return;
      }
      attempt.last_heartbeat_at = nowIso();
      state.latestAttempt = { ...attempt };
      persistState();
      sendJson(response, 200, {
        accepted: true,
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
        cancel_requested: false,
      });
      return;
    }

    const attemptCompleteMatch = path.match(/^\/v1\/attempts\/([^/]+)\/complete$/);
    if (method === 'POST' && attemptCompleteMatch) {
      if (!requireLease()) {
        return;
      }
      const body = await parseBody(request);
      attempt.status = 'completed';
      attempt.finished_at = nowIso();
      attempt.result_summary = body.result_summary;
      attempt.result_json = body.result_json ?? null;
      state.job.status = 'completed';
      state.job.result_summary = body.result_summary;
      state.job.result_json = body.result_json ?? null;
      state.latestAttempt = { ...attempt };
      persistState();
      sendJson(response, 200, { job_status: 'completed' });
      return;
    }

    const attemptFailMatch = path.match(/^\/v1\/attempts\/([^/]+)\/fail$/);
    if (method === 'POST' && attemptFailMatch) {
      if (!requireLease()) {
        return;
      }
      const body = await parseBody(request);
      attempt.status = 'failed';
      attempt.finished_at = nowIso();
      attempt.failure_code = body.failure_code;
      attempt.failure_message = body.failure_message;
      state.job.status = 'failed';
      state.latestAttempt = { ...attempt };
      persistState();
      sendJson(response, 200, { job_status: 'failed' });
      return;
    }

    const attemptCancelledMatch = path.match(/^\/v1\/attempts\/([^/]+)\/cancelled$/);
    if (method === 'POST' && attemptCancelledMatch) {
      if (!requireLease()) {
        return;
      }
      const body = await parseBody(request);
      attempt.status = 'cancelled';
      attempt.finished_at = nowIso();
      attempt.result_summary = body.result_summary ?? 'cancelled';
      state.job.status = 'cancelled';
      state.latestAttempt = { ...attempt };
      persistState();
      sendJson(response, 200, { job_status: 'cancelled' });
      return;
    }

    const artifactMatch = path.match(/^\/v1\/attempts\/([^/]+)\/artifacts$/);
    if (method === 'POST' && artifactMatch) {
      if (!requireLease()) {
        return;
      }
      const body = await parseBody(request);
      const artifact = {
        artifact_id: createId('artifact', state.artifacts.length + 1),
        ...body,
      };
      state.artifacts.push(artifact);
      persistState();
      sendJson(response, 200, { artifact_id: artifact.artifact_id });
      return;
    }

    const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/);
    if (method === 'GET' && jobMatch) {
      sendJson(response, 200, {
        job: state.job,
        latest_attempt: state.latestAttempt,
        artifacts: state.artifacts,
        history_summary: state.latestAttempt ? [state.latestAttempt] : [],
      });
      return;
    }
  } catch (error) {
    sendJson(response, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  notFound(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock control plane listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
