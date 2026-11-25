import { projects, type Db } from "@paperclipai/db";
import type { BudgetExecutionAction } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity } from "./activity-log.js";
import { scopeHasBudgetHardStop } from "./budgets.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { promoteDeferredWorkIntents } from "./work-intent-outbox.js";

/** Gate project admission without pausing its agents or mutating its policies. */
export async function setProjectExecutionPause(db: Db, companyId: string, projectId: string,
  action: BudgetExecutionAction, actorId: string) {
  return withAccountingTransaction(db, companyId, async (tx, publications) => {
    const scope = and(eq(projects.companyId, companyId), eq(projects.id, projectId));
    const [project] = await tx.select().from(projects).where(scope).for("update");
    if (!project) throw notFound("Project not found");
    if (project.archivedAt) throw conflict("Archived projects cannot change execution state");
    if (action === "pause") {
      if (project.pausedAt || project.pauseReason) throw conflict("This project already has a pause");
    } else {
      if (!project.pausedAt || project.pauseReason !== "manual") {
        throw conflict("This project does not have a manual pause to release");
      }
      if (await scopeHasBudgetHardStop(tx, companyId, "project", projectId)) {
        throw conflict("Resolve the project budget hard stop before resuming work");
      }
    }

    const now = new Date();
    if (action === "pause") {
      await notifyRunDispatch(tx, { companyId });
      await notifyDeferredExecutionEligibility(tx, { companyId });
    } else {
      await promoteDeferredWorkIntents(tx, { companyId, trigger: "pause_lifted" });
    }
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.routineSchedules);
    await tx.update(projects).set({
      pauseReason: action === "pause" ? "manual" : null,
      pausedAt: action === "pause" ? now : null,
      updatedAt: now,
    }).where(scope);
    await logActivity(tx, {
      companyId, actorType: "user", actorId, action: "project.updated",
      entityType: "project", entityId: projectId,
      details: { reason: "manual_execution", executionAction: action },
    }, publications);
  });
}
