# remote-worker-agent

`remote-worker-agent`는 EJClaw remote worker control plane과 통신하는 `worker pull` 실행기 골격입니다.

현재 범위:

- worker 등록 / heartbeat / claim / start / complete / fail / cancelled
- file-based session reuse 저장소
- `git clone/fetch + worktree` 기반 workspace 준비
- `codex` strict 실행기 연동
- `claude-code` 실행기 어댑터 골격
- 기본 테스트

아직 포함하지 않은 것:

- `claude-code` 실제 CLI 연동
- artifact 외부 저장소 업로드

## 실행

의존성 설치:

```bash
npm install
```

환경 파일 준비:

```bash
cp .env.example .env
```

1회 실행:

```bash
npm run start:once
```

예상 출력:

```text
idle
completed job=job_123 summary="Applied requested changes"
failed job=job_123 reason="Control plane request failed with status 401"
cancelled job=job_123 reason="Cancelled by control plane"
```

루프 실행:

```bash
npm run start
```

## 환경 변수

- repo 루트의 `.env`는 자동 로드됩니다
- 셸에서 직접 넣은 환경변수가 `.env`보다 우선합니다

- `CONTROL_PLANE_BASE_URL` 예: `http://127.0.0.1:8787`
- `CONTROL_PLANE_TOKEN` Bearer token
- `WORKER_ID` 워커 식별자
- `WORKER_DISPLAY_NAME` 표시 이름
- `WORKER_CAPABILITIES` 콤마 구분 capability token
- `WORKER_MAX_CONCURRENCY` 기본 `1`
- `WORKER_DEFAULT_PROVIDER` `codex | claude-code`, 기본 `codex`
- `WORKER_EXECUTION_MODE` `dry-run | strict`, 기본 `dry-run`
- `WORKER_CODEX_BIN` 기본 `codex`
- `WORKER_CODEX_MODEL` 선택, 예: `gpt-5.4-codex`
- `WORKER_CODEX_SANDBOX` 기본 `workspace-write`
- `CODEX_HOME`, `OPENAI_API_KEY` 같은 Codex 런타임 env도 `.env`에서 그대로 전달됩니다
- `WORKER_POLL_INTERVAL_MS` 기본 `5000`
- `WORKER_WORKSPACE_ROOT` 기본 `.workspaces`
  - 내부적으로 `.repo-cache/`에 원격 repo 캐시를 두고, job별 worktree를 생성합니다
- `WORKER_SESSION_STORE` 기본 `.sessions/store.json`
- private repo 인증이 필요하면 `WORKER_GIT_SSH_COMMAND`, `WORKER_GIT_ASKPASS`, `WORKER_GIT_TERMINAL_PROMPT`, `WORKER_SSH_AUTH_SOCK`를 `.env`에 둘 수 있습니다
- `base_commit`은 원격 repo에서 fetch 가능한 커밋이어야 합니다

## 구조

- `src/control-plane-client.ts`: HTTP client
- `src/worker.ts`: orchestration loop
- `src/session-store.ts`: session persistence
- `src/repo-workspace.ts`: git worktree 기반 workspace 준비
- `src/executors/codex.ts`: 실제 `codex exec` 연동
- `src/executors/claude-code.ts`: skeleton

## Strict 시험 시나리오

1. Windows worker `.env`

```env
CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787
CONTROL_PLANE_TOKEN=<shared-secret>
WORKER_ID=worker-win-01
WORKER_DISPLAY_NAME=Windows Worker 01
WORKER_CAPABILITIES=os:windows,tool:codex,tool:git
WORKER_DEFAULT_PROVIDER=codex
WORKER_EXECUTION_MODE=strict
WORKER_CODEX_BIN=codex
WORKER_CODEX_SANDBOX=workspace-write
WORKER_GIT_SSH_COMMAND=ssh -i C:/Users/you/.ssh/id_ed25519 -o IdentitiesOnly=yes
WORKER_GIT_TERMINAL_PROMPT=0
```

2. Windows에서 사전 확인

```bash
codex --version
npm run start
```

3. Control plane에 smoke job enqueue

```json
{
  "workspace_key": "repo:remote-worker-agent-smoke",
  "repo_url": "git@github.com:TailFox-31/remote-worker-agent.git",
  "branch": "main",
  "base_commit": "<origin/main commit>",
  "mode": "edit",
  "requirements": ["tool:codex", "os:windows"],
  "prompt": "Open README.md, append a short line that says `Strict smoke test executed.`, then stop.",
  "target_files": ["README.md"],
  "session_policy": "fresh",
  "timeout_sec": 1800,
  "priority": 100,
  "max_attempts": 1
}
```

4. 기대 결과

```text
completed job=<job_id> summary="..."
```

5. Control plane 확인 포인트

- `jobs.status = completed`
- `latest_attempt.provider = codex`
- `artifacts`에 `report`, `stdout`, `stderr`, 변경이 있으면 `patch`

## CI/CD

기본 CI:

- [ci.yml](/home/faust/work/TFClaw/data/workspaces/tfclaw_dev3/remote-worker-agent/.github/workflows/ci.yml)
- `ubuntu-latest`에서 `npm test`, `typecheck`, `build`

Windows self-hosted smoke:

- [windows-self-hosted-smoke.yml](/home/faust/work/TFClaw/data/workspaces/tfclaw_dev3/remote-worker-agent/.github/workflows/windows-self-hosted-smoke.yml)
- repo 내부 [mock-control-plane.mjs](/home/faust/work/TFClaw/data/workspaces/tfclaw_dev3/remote-worker-agent/scripts/mock-control-plane.mjs) 를 띄워 `start:once`를 검증
- 외부 EJClaw 서비스에 의존하지 않아서 runner 환경 검증에 적합

Windows self-hosted strict Codex smoke:

- [windows-self-hosted-strict-codex-smoke.yml](/home/faust/work/TFClaw/data/workspaces/tfclaw_dev3/remote-worker-agent/.github/workflows/windows-self-hosted-strict-codex-smoke.yml)
- 실제 `codex` CLI를 사용해 temp repo의 `README.md`를 수정
- mock control plane state에서 `completed`와 `patch` artifact 내용을 함께 검증
- runner 서비스 계정에 Codex 인증 또는 `OPENAI_API_KEY` secret이 필요
- runner 서비스 PATH에 `codex`가 없으면 사용자 프로필의 npm shim 경로를 자동 탐색하고, 그래도 못 찾으면 repo variable `WORKER_CODEX_BIN`으로 전체 경로를 지정할 수 있음

운영용 e2e와의 역할 분리:

- 이 workflow는 `worker agent 자체`의 smoke
- 실제 EJClaw control plane과 붙는 통합 검증은 별도 workflow나 수동 smoke로 두는 편이 안전
