---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

Typically reported automatically by adapters after each heartbeat.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the current month.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

### Pause or resume execution

```
POST /api/companies/{companyId}/budgets/execution
{ "scopeType": "project", "scopeId": "{projectId}", "action": "pause" }
```

This requires a board administrator with access to the company. Agent controls
also require permission to manage agents. Scope types are `company`, `agent`,
and `project`; the scope ID must belong to the company. `pause` and `resume` do
not create or change budgets. Organization and agent pause request Stop for
active agent runs. Project pause blocks new work but does not stop existing runs.
Resume releases only a manual pause, not a budget hard stop or other hold.
Eligible actions are shown under Audit → Budgets, even without a budget policy.

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget windows reset on the first of each month (UTC).
