# @aab/subagents

`DelegationManager`: on `delegation.started` it gets the child's scoped token + view from the
world, asks the host (the runner) to provision the child's own proxy listeners, browser profile
and trace dir, runs a child adapter of the same kind with step / wall-clock limits, files the
child's final response as a `subagent.report` (via `runner`) if the child filed none — a claim,
never a budget change — and ends the delegation (`completed` / `timeout` / `error` / `cancelled`).
