import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  projects,
} from "@paperclipai/db";
import { applyAgentBudgetHoldInTransaction, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { companyService } from "../services/companies.js";
import { setProjectExecutionPause } from "../services/project-execution-pause.js";
import { budgetService, deliverBudgetEnforcement, hasPendingBudgetEnforcement, flushBudgetEvaluationWork } from "../services/budgets.ts";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  persistActivity: vi.fn(async () => ({ activity: null, publication: null })),
}));

// Budget behavior is exercised against PostgreSQL below and in
// cost-accounting-reliability.test.ts, including transaction and retry paths.

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_BUDGETS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../services/agent-lifecycle.js");
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(nativeRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  it("pauses organization work without a cap and does not resume another hold", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const companiesService = companyService(db);
    const actor = { actorType: "user", actorId: "board" } as const;
    const service = budgetService(db);
    await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"], pauseReason: "manual" })
      .where(eq(agents.id, agentId));
    const [working] = await db.insert(agents).values({
      companyId, name: "Working agent", role: "engineer", status: "running", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId: working.id, scopeKind: "company", status: "running" });
    await expect(companiesService.update(companyId, {}, actor, "pause"))
      .resolves.toMatchObject({ status: "paused", pauseReason: "manual", budgetMonthlyCents: 0 });
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({ scopeType: "company" });
    const [fenced] = await db.select().from(agents).where(eq(agents.id, working.id));
    expect(fenced.lifecycleState).toBe("pausing");
    expect(fenced.lifecycleHolds).toContain("company_paused");
    expect((await service.overview(companyId, { includeAgents: true })).organizationExecution).toEqual({ action: "resume" });
    expect((await service.overview(companyId)).organizationExecution).toBeUndefined();
    await expect(companiesService.update(companyId, { status: "active" }, actor)).rejects.toMatchObject({ status: 409 });
    await expect(companiesService.update(companyId, {}, actor, "resume"))
      .resolves.toMatchObject({ status: "active", pauseReason: null, pausedAt: null, budgetMonthlyCents: 0 });
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.lifecycleHolds).toContain("manual");
    await db.update(companies).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() }).where(eq(companies.id, companyId));
    await expect(companiesService.update(companyId, {}, actor, "resume")).rejects.toMatchObject({ status: 409 });
    expect((await companiesService.getById(companyId))?.pauseReason).toBe("budget");
  });

  it("lists and refreshes eligible execution scopes without requiring a budget policy", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const other = await createBudgetFixture();
    const service = budgetService(db);
    const unbudgeted = () => service.overview(companyId, { includeAgents: true });
    expect((await service.overview(companyId)).unbudgetedExecution).toBeUndefined();
    expect((await unbudgeted()).unbudgetedExecution).toEqual([
      { scopeType: "agent", scopeId: agentId, name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK", action: "pause" },
      { scopeType: "project", scopeId: projectId, name: "Budget Project", action: "pause" },
    ]);
    expect((await service.overview(companyId, { includeAgents: false })).unbudgetedExecution).toEqual([
      { scopeType: "project", scopeId: projectId, name: "Budget Project", action: "pause" },
    ]);

    await createAgentLifecycle(db).setManualExecutionPause(agentId, true);
    await setProjectExecutionPause(db, companyId, projectId, "pause", "board");
    expect((await unbudgeted()).unbudgetedExecution?.map(({ action }) => action)).toEqual(["resume", "resume"]);
    expect((await unbudgeted()).policies).toEqual([]);
    // No lifecycle worker runs in this service test. Settle the pending Stop.
    await db.update(agents).set({ status: "paused", lifecycleState: "paused" }).where(eq(agents.id, agentId));
    await createAgentLifecycle(db).setManualExecutionPause(agentId, false);
    await setProjectExecutionPause(db, companyId, projectId, "resume", "board");
    const [scopes, policies] = await Promise.all([unbudgeted(), service.overview(other.companyId, { includeAgents: true })]);
    expect(scopes.unbudgetedExecution?.map(({ action }) => action)).toEqual(["pause", "pause"]);
    expect(policies.unbudgetedExecution?.map(({ scopeId }) => scopeId)).toEqual([other.agentId, other.projectId]);

    await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, amount: 100 }, null);
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    const capped = await unbudgeted();
    expect(capped.unbudgetedExecution).toEqual([]);
    expect(capped.policies[0]).toMatchObject({ scopeId: agentId, executionAction: "pause" });
    expect((await service.overview(companyId)).policies[0]?.executionAction).toBeUndefined();
    expect((await service.overview(companyId, { includeAgents: false })).policies[0]?.executionAction).toBeUndefined();
  });

  it("gates only the selected project and preserves a hard stop discovered while manual pause is active", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const service = budgetService(db);
    const input = { scopeType: "project", scopeId: projectId, windowKind: "lifetime", amount: 100 } as const;
    await service.upsertPolicy(companyId, input, null);
    await setProjectExecutionPause(db, companyId, projectId, "pause", "board");
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toMatchObject({ scopeType: "project", scopeId: projectId });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
    await expect(setProjectExecutionPause(db, companyId, randomUUID(), "resume", "board")).rejects.toMatchObject({ status: 404 });
    const other = await createBudgetFixture();
    await expect(setProjectExecutionPause(db, other.companyId, projectId, "resume", "board")).rejects.toMatchObject({ status: 404 });
    await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await expect(setProjectExecutionPause(db, companyId, projectId, "resume", "board")).rejects.toMatchObject({ status: 409 });
    const [held] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(held.pauseReason).toBe("manual");
    expect((await service.overview(companyId)).policies.find(policy => policy.scopeId === projectId)).toMatchObject({ amount: 100 });
    await service.upsertPolicy(companyId, { ...input, amount: 200 }, null);
    await setProjectExecutionPause(db, companyId, projectId, "resume", "board");
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
    expect((await service.overview(companyId)).policies.find(policy => policy.scopeId === projectId)).toMatchObject({ amount: 200 });
  });

  it("removes only the manual agent hold and refuses a stale agent resume", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.setManualExecutionPause(agentId, true);
    await withAccountingTransaction(db, companyId, (tx, publications) =>
      applyAgentBudgetHoldInTransaction(tx, companyId, agentId, true, publications));
    await lifecycle.setManualExecutionPause(agentId, false);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.lifecycleHolds).toEqual(["budget"]);
    expect(agent.pauseReason).toBe("budget");
    await expect(lifecycle.setManualExecutionPause(agentId, false)).rejects.toThrow("does not have a manual pause");
  });

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  it.each(["no policy", "healthy policy", "warning policy", "manual company pause", "manual project pause", "orphan budget pause", "recovering run"])(
    "checks %s while another accounting writer holds the company lock",
    async state => {
      const { companyId, agentId, projectId } = await createBudgetFixture();
      if (state === "healthy policy" || state === "warning policy" || state === "recovering run") {
        const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
          windowKind: "calendar_month_utc", amount: 100 }).returning();
        if (state !== "recovering run") await insertCostEvent({ companyId, agentId, costCents: state === "warning policy" ? 80 : 20 });
        if (state === "warning policy") {
          const now = new Date();
          await db.insert(budgetIncidents).values({ companyId, policyId: policy.id, scopeType: "company", scopeId: companyId,
            metric: "billed_cents", windowKind: "calendar_month_utc",
            windowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
            windowEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
            thresholdType: "soft", amountLimit: 100, amountObserved: 80 });
        }
      }
      if (state === "recovering run") {
        const [issue] = await db.insert(issues).values({ companyId, projectId, title: "Recover accounting" }).returning();
        const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId: issue.id,
          nativeIssueId: issue.id, runtimeMode: "native", status: "failed", finishedAt: new Date(), costAccountingPending: true }).returning();
        await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id, phase: "observed" });
      }
      if (state === "manual company pause" || state === "orphan budget pause") {
        await db.update(companies).set({ status: "paused", pauseReason: state === "orphan budget pause" ? "budget" : "manual" })
          .where(eq(companies.id, companyId));
      }
      if (state === "manual project pause") {
        await db.update(projects).set({ pausedAt: new Date(), pauseReason: "manual" }).where(eq(projects.id, projectId));
      }

      const reader = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 1 });
      let acquired!: () => void, release!: () => void;
      const lockAcquired = new Promise<void>(resolve => { acquired = resolve; });
      const holdLock = new Promise<void>(resolve => { release = resolve; });
      const writer = db.transaction(async tx => {
        await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
        acquired();
        await holdLock;
      });
      try {
        await Promise.race([lockAcquired, writer]);
        await reader.execute(sql`set lock_timeout = '500ms'`);
        if (state === "recovering run") {
          // Invariant 3: a recovering run's accounting never gates admission.
          await expect(budgetService(reader).getInvocationBlock(companyId, agentId, { projectId })).resolves.toBeNull();
        } else {
          const block = await budgetService(reader).getInvocationBlock(companyId, agentId, { projectId });
          if (state === "manual company pause") {
            expect(block).toMatchObject({ scopeType: "company", scopeId: companyId,
              reason: "Company is paused and cannot start new work." });
          } else if (state === "manual project pause") {
            expect(block).toMatchObject({ scopeType: "project", scopeId: projectId,
              reason: "Project is paused and cannot start new work." });
          } else if (state === "orphan budget pause") {
            expect(block).toMatchObject({ scopeType: "company", scopeId: companyId,
              reason: "Budget pause requires a policy or an explicit operator resume." });
          } else expect(block).toBeNull();
          if (state === "warning policy") {
            expect(await reader.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId)))
              .toMatchObject([{ thresholdType: "soft", status: "open", resolvedAt: null }]);
          }
          if (state === "no policy") {
            await expect(budgetService(reader).evaluateAdmission(companyId, agentId, { projectId }))
              .resolves.toMatchObject({ block: null, policies: [], observations: [] });
          }
        }
      } finally {
        release();
        try { await writer; }
        finally { await reader.$client.end({ timeout: 1 }); }
      }
      if (state === "recovering run") {
        const cancelWorkForScope = vi.fn();
        expect(await budgetService(db, { cancelWorkForScope }).getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
        expect(cancelWorkForScope).not.toHaveBeenCalled();
        expect((await db.select().from(companies).where(eq(companies.id, companyId)))[0])
          .toMatchObject({ status: "active", pauseReason: null });
        expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0])
          .toMatchObject({ status: "active", pauseReason: null });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
          .toMatchObject([{ status: "failed", costAccountingPending: true }]);
        expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId)))
          .toMatchObject([{ phase: "observed", resultId: null }]);
      }
    },
  );

  it.each([true, false])("releases an agent budget hold when its policy is healthy (active: %s)", async isActive => {
    const { companyId, agentId } = await createBudgetFixture();
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", amount: 100, isActive });
    await db.update(agents).set({ status: "paused", lifecycleState: "paused", pauseReason: "budget", pausedAt: new Date(), lifecycleHolds: ["budget"] })
      .where(eq(agents.id, agentId));

    // A budget hold with no reached hard stop is stale. Budget admission does
    // not wait for its reconciliation (invariant 3); the paused agent itself is
    // an explicit pause that agent invokability refuses until the worker lifts it.
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).toBeNull();
    await budgetService(db).evaluateAffectedScopes(companyId, agentId, null);
    await flushBudgetEvaluationWork(db, { companyId });
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({
      lifecycleState: "resuming", pauseReason: null, lifecycleHolds: [],
    });
  });

  it.each(["hard", "soft"])("resolves an obsolete %s incident even when the scope no longer has a budget hold", async thresholdType => {
    const { companyId, agentId } = await createBudgetFixture();
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", amount: 100 }).returning();
    const [incident] = await db.insert(budgetIncidents).values({ companyId, policyId: policy.id, scopeType: "agent", scopeId: agentId,
      metric: "billed_cents", windowKind: "calendar_month_utc", windowStart: new Date(0), windowEnd: new Date(1),
      thresholdType, amountLimit: 100, amountObserved: 100 }).returning();

    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).toBeNull();
    await budgetService(db).evaluateAffectedScopes(companyId, agentId, null);
    await flushBudgetEvaluationWork(db, { companyId });
    expect((await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incident.id)))[0])
      .toMatchObject({ status: "resolved", resolvedAt: expect.any(Date) });
  });

  it("rejects another company's agent or project before allowing a no-policy invocation", async () => {
    const own = await createBudgetFixture();
    const other = await createBudgetFixture();
    const service = budgetService(db);
    await expect(service.getInvocationBlock(own.companyId, other.agentId)).rejects.toThrow("Budget scope not found");
    await expect(service.getInvocationBlock(own.companyId, own.agentId, { projectId: other.projectId }))
      .rejects.toThrow("Budget scope not found");
  });

  it("raises one soft incident per window before hard-stopping and preserving safe local audit details", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);
    await flushBudgetEvaluationWork(db, { companyId });

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      approvalId: null,
      status: "open",
    });

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);
    await flushBudgetEvaluationWork(db, { companyId });

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await hasPendingBudgetEnforcement(db)).toBe(true);
    const [pendingPolicy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id));
    expect(pendingPolicy.enforcementVersion).toBe(1);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const [afterAdmission] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id));
    expect(afterAdmission.enforcementVersion).toBe(pendingPolicy.enforcementVersion);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    const activityCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(activityCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(activityCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(activityCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of activityCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("distinguishes a company budget pause from a manual company pause", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Budget pause requires a policy or an explicit operator resume.",
    });
    await db.update(companies).set({ pauseReason: null }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Company is paused and cannot start new work.",
    });
  });

  it.each([false, true])("only signals a real project budget pause with concurrent admission checks (already paused: %s)", async alreadyPaused => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    await db.insert(budgetPolicies).values({ companyId, scopeType: "project", scopeId: projectId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, hardStopEnabled: true, notifyEnabled: false });
    await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    const pausedAt = new Date("2020-01-01T00:00:00.000Z");
    if (alreadyPaused) await db.update(projects).set({ pausedAt, pauseReason: "manual" }).where(eq(projects.id, projectId));
    const dispatch = vi.fn(), deferred = vi.fn();
    const unsubscribe = [subscribeDeliveryWork(db, DELIVERY_QUEUES.queuedRunDispatch, dispatch),
      subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, deferred)];
    try {
      const service = budgetService(db);
      const blocks = await Promise.all(Array.from({ length: 4 }, () => service.getInvocationBlock(companyId, agentId, { projectId })));
      expect(blocks.every(block => block?.scopeType === "project" && block.scopeId === projectId)).toBe(true);
      await service.evaluateAffectedScopes(companyId, agentId, projectId);
      await flushBudgetEvaluationWork(db, { companyId });
      const [paused] = await db.select().from(projects).where(eq(projects.id, projectId));
      expect(paused).toMatchObject({ pauseReason: alreadyPaused ? "manual" : "budget", pausedAt: alreadyPaused ? pausedAt : expect.any(Date) });
      expect(dispatch).toHaveBeenCalledTimes(alreadyPaused ? 0 : 1);
      expect(deferred).toHaveBeenCalledTimes(alreadyPaused ? 0 : 1);
      await Promise.all(Array.from({ length: 4 }, () => service.getInvocationBlock(companyId, agentId, { projectId })));
      expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]).toEqual(paused);
      expect(dispatch).toHaveBeenCalledTimes(alreadyPaused ? 0 : 1);
      expect(deferred).toHaveBeenCalledTimes(alreadyPaused ? 0 : 1);
    } finally { unsubscribe.forEach(stop => stop()); }
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);
    await flushBudgetEvaluationWork(db, { companyId });

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({ status: "active", lifecycleHolds: [] });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });

  it("discards stale undelivered enforcement when a budget is raised before dispatch", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await service.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId,
      amount: 100, windowKind: "lifetime" }, "board");
    await service.evaluateCostEvent(await insertCostEvent({ companyId, agentId, projectId, costCents: 125 }));
    await flushBudgetEvaluationWork(db, { companyId });
    expect(await hasPendingBudgetEnforcement(db)).toBe(true);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    await service.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId,
      amount: 200, windowKind: "lifetime" }, "board");
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await hasPendingBudgetEnforcement(db)).toBe(false);
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
  });

  it("retains failed cancellation delivery and retries without replaying accounting", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const service = budgetService(db);
    await service.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId,
      amount: 100, windowKind: "lifetime" }, "board");
    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await flushBudgetEvaluationWork(db, { companyId });
    const cancelWorkForScope = vi.fn().mockRejectedValueOnce(new Error("Controlled stop delivery failure")).mockResolvedValue(undefined);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(await hasPendingBudgetEnforcement(db)).toBe(true);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0].pauseReason).toBe("budget");
    const [afterFailure] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
    expect(afterFailure.enforcementVersion).toBeGreaterThan(afterFailure.enforcementDeliveredVersion);
    await deliverBudgetEnforcement(db, { cancelWorkForScope }, companyId);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(await hasPendingBudgetEnforcement(db)).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
    expect((await db.select().from(budgetIncidents)).filter(incident => incident.thresholdType === "hard")).toHaveLength(1);
  });

});
