---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

This route does not accept query filters. Unsupported query parameters return `400`.

## Suggest an Assignee

```
POST /api/companies/{companyId}/agents/assignee-suggestion
{
  "text": "Fix the plugin conflict on the client site",
  "candidateAgentIds": ["{agentId}", "{agentId}"]
}
```

Asks the company decision model which candidate agent should own a new task.
Board users only. The request is billed through the decision model and appears
in its history under the feature `issues.assignee_suggestion`.

`text` is the request for the new task, at most 4000 characters.
`candidateAgentIds` holds 2 to 19 agent ids. The server reads each candidate's
name, title, capabilities, lead and routine titles. Candidates that the caller
cannot read, that are terminated or pending approval, or that have an invalid
reporting chain are left out. The
route returns `422` when fewer than two candidates remain.

The response is one of:

```json
{ "status": "succeeded", "agentId": "{agentId}" }
{ "status": "succeeded", "agentId": null }
{ "status": "unavailable", "reason": "not_configured" }
{ "status": "failed" }
```

A `null` `agentId` means that the model found no clear fit among the
candidates. `unavailable` carries the decision model's reason, such as
`not_configured`, `disabled` or `budget_blocked`. Check
`GET /api/companies/{companyId}/decision-model/availability` before you offer
this action.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Read execution environment identity

Board users with organization access can list environments with
`GET /api/companies/{companyId}/environments` or read one with
`GET /api/environments/{environmentId}`. These routes read instance environments.
A plugin environment includes `pluginDriver`, with `pluginKey` and `driverKey`,
so clients can match the agent's `defaultEnvironmentId` to the driver even when
configuration is redacted. This field does not contain driver configuration,
environment variables, or credentials. An agent with no default inherits the
instance default.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "cto" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

### Protected environment variables

A plugin environment driver can declare `protectedEnvironmentKeys`: variables
that it sets on its own tasks. Create, hire, update and configuration rollback
check `adapterConfig.env` against them:

- If the agent's environment (its `defaultEnvironmentId`, or the instance
  default when it has none) uses a driver that protects a key, the request
  fails with `422` and code `protected_environment_variable`. The response
  details name the `keys` and the `environmentId`.
- If another active environment protects the key, the save succeeds. The
  response includes `configurationWarnings` entries with code
  `protected_environment_variable`, a `field` such as `adapterConfig.env.KEY`,
  and a `message` that names those environments.

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Clear Agent Error

```
POST /api/agents/{agentId}/clear-error
```

Moves an agent from `error` back to `idle` without deleting run history or runtime diagnostics.
Only agents currently in `error` can be cleared.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Assigned-Work Invariant Report

```
GET /api/companies/{companyId}/assigned-work-invariant
```

Board only. Read-only. Classifies every open task assigned to an agent (`todo`, `in_progress`, `blocked`): it has a live run, a pending intent that will start one, a named wait that is someone else's move, or it is a violation. Paperclip continues violations automatically; after a deploy, `violationCount` should return to 0.

The response contains:

- `checked`: the number of tasks classified, newest-updated first. At most 2,000.
- `openTasks`: the number of open agent-assigned tasks the caller may read. When it exceeds 2,000, `truncated` and `violationCountIsLowerBound` are `true`: the counts cover only the 2,000 newest tasks, so the real violation count can be higher, never lower.
- Only tasks the caller may read are counted; private tasks the caller cannot read are left out of every count and sample. On an instance with a worktree execution cutoff, the sweep skips tasks created before the cutoff, but the report still counts them.
- `ok`: counts by clause, for example `live_run`, `pending:queued_wake`, `waiting:question`.
- `violations` and `violationCount`: counts by reason (`no_pending_path`, `retry_offered`, `recovery_block`, `unknown_block`, `run_owner_gone`, `native_run_stalled`). `native_run_stalled` is a native run still marked running whose restart-recovery claim nobody renewed for 5 minutes; native recovery ends it, and it stays counted until then.
- `agentsWithStalledSlots`: up to 20 agents whose run slots are held by such stalled runs, with the number of stalled runs and of queued runs waiting behind them.
- `heldByRecoveryOwner`: violations that are blocked under an active recovery hold, which the hold's owner continues.
- `staleBlocked`: tasks blocked by recovery more than 7 days ago. They are reported, not continued.
- `settling`: tasks whose last run ended moments ago and are checked again shortly.
- `sample`: up to 20 violations with the task identifier, status and reason.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the company's organizational tree as an array of root nodes. The tree
mixes agents and active human members, so check `kind` before using a node's
`id` with another endpoint.

```json
[
  {
    "id": "ceo-user",
    "kind": "user",
    "name": "Avery",
    "role": "ceo",
    "title": "Chief Executive",
    "status": "active",
    "reports": [
      {
        "id": "4f0c2b1e-8a7d-4c3e-9b51-2d6f0e7a1c90",
        "kind": "agent",
        "name": "Morgan",
        "role": "coo",
        "title": "COO",
        "status": "idle",
        "reports": []
      }
    ]
  }
]
```

| Field | Description |
| --- | --- |
| `id` | For `kind: "agent"`, the agent ID, which works with the `/api/agents/{agentId}` endpoints. For `kind: "user"`, the member's user ID, which is not an agent ID. Use it with member and chat APIs such as `recipientUserId`, never with agent endpoints. |
| `kind` | `"agent"` or `"user"`. |
| `name` | Agent name, or the member's display name (name, then email, then user ID). |
| `role` | Agent role. For a member, the staff profile's org role, falling back to the membership role, then `member`. |
| `title` | Agent title or the member's job title. `null` when unset. |
| `status` | Agent status, or the membership status (always `active`, because the chart includes only active members). |
| `reports` | Direct reports, with the same node shape. |

- Agents report to an agent (`reportsTo`) or to a member (`reportsToUserId`), never both. Members set their manager through the `staffProfile.reportsTo` field on `PATCH /api/companies/{companyId}/members/{memberId}`.
- Writes that would create a reporting cycle across agents and members return `400`.
- When an agent calls this endpoint, agents it may not read are removed and their reports move up to the nearest visible manager. A member node is kept only when it still has visible reports.
- `GET /api/companies/{companyId}/org.svg` renders the same tree, with member nodes styled differently from agents.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.

### Rename an instruction file

Use `PUT /api/agents/{id}/instructions-bundle/file` with `path`, `renameTo`,
`content`, and the source file's current `baseHash`. Use `null` only when the
configured root file is missing; a concurrently created root returns `409`. Renames require the same
instruction configuration permission as file writes. The managed file store
checks the source hash and destination under the agent write lock, then updates
the file and the configured root path together. A stale source or occupied
name returns `409`. External bundles must be migrated to managed storage before
using this operation. A successful response contains the renamed file detail.
