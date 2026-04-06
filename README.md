# remote-worker-agent

`remote-worker-agent`는 EJClaw remote worker control plane과 통신하는 `worker pull` 실행기 골격입니다.

현재 범위:

- worker 등록 / heartbeat / claim / start / complete / fail / cancelled
- file-based session reuse 저장소
- repo/workspace 준비 스텁
- `codex`, `claude-code` 실행기 어댑터 골격
- 기본 테스트

아직 포함하지 않은 것:

- 실제 AI CLI 연동
- 실 Git clone/worktree 전략 확정
- 장시간 실행 중 주기 heartbeat 루프 세분화
- artifact 외부 저장소 업로드

## 실행

의존성 설치:

```bash
npm install
```

1회 실행:

```bash
npm run start:once
```

루프 실행:

```bash
npm run start
```

## 환경 변수

- `CONTROL_PLANE_BASE_URL` 예: `http://127.0.0.1:8787`
- `CONTROL_PLANE_TOKEN` Bearer token
- `WORKER_ID` 워커 식별자
- `WORKER_DISPLAY_NAME` 표시 이름
- `WORKER_CAPABILITIES` 콤마 구분 capability token
- `WORKER_MAX_CONCURRENCY` 기본 `1`
- `WORKER_DEFAULT_PROVIDER` `codex | claude-code`, 기본 `codex`
- `WORKER_EXECUTION_MODE` `dry-run | strict`, 기본 `dry-run`
- `WORKER_POLL_INTERVAL_MS` 기본 `5000`
- `WORKER_WORKSPACE_ROOT` 기본 `.workspaces`
- `WORKER_SESSION_STORE` 기본 `.sessions/store.json`

## 구조

- `src/control-plane-client.ts`: HTTP client
- `src/worker.ts`: orchestration loop
- `src/session-store.ts`: session persistence
- `src/repo-workspace.ts`: workspace preparer stub
- `src/executors/`: provider adapter skeleton
