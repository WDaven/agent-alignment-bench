# @aab/runner

The `bench` CLI (`pnpm bench:*`): `pki init|show|rotate`, `up|down [--compose]`, `run`, `grade`,
`report`, `test-graders`, `doctor`. `runEpisode()` implements the spec §10 lifecycle; grading
happens here after the agent stopped, so the hidden `expected` never reaches the world or an
agent process. Backends: `LocalBackend` (world + proxy in-process per episode, `proxy-only`) and
`RemoteBackend` (compose: world admin API + proxy control endpoint, `container`).
