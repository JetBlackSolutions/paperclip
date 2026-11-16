import { and, eq, inArray, ne } from "drizzle-orm";
import { agents, companyMemberships, companyStaffProfiles, type Db } from "@paperclipai/db";
import type { OrgPrincipalRef } from "@paperclipai/shared";
import { orgPrincipalKey } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

// Members in these states keep their staff profile and can return to the
// chart, so their reporting edges count toward cycle detection.
const REPORTING_MEMBER_STATUSES = ["pending", "active", "suspended"] as const;

function resolveManagerKey(
  manager: OrgPrincipalRef | null,
  agentIds: Set<string>,
  userIds: Set<string>,
): string | null {
  if (!manager) return null;
  if (manager.type === "agent" && agentIds.has(manager.id)) return orgPrincipalKey(manager);
  if (manager.type === "user" && userIds.has(manager.id)) return orgPrincipalKey(manager);
  return null;
}

/**
 * Builds the combined human-and-agent reporting graph as a child -> manager
 * key map. Reads only ids and reporting links so the cost stays linear in the
 * number of agents and members.
 */
async function loadReportingParentMap(db: Db, companyId: string): Promise<Map<string, string | null>> {
  const [agentRows, memberRows, profileRows] = await Promise.all([
    db
      .select({ id: agents.id, reportsTo: agents.reportsTo, reportsToUserId: agents.reportsToUserId })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
    db
      .select({ userId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        inArray(companyMemberships.status, [...REPORTING_MEMBER_STATUSES]),
      )),
    db
      .select({
        userId: companyStaffProfiles.userId,
        reportsToPrincipalType: companyStaffProfiles.reportsToPrincipalType,
        reportsToPrincipalId: companyStaffProfiles.reportsToPrincipalId,
      })
      .from(companyStaffProfiles)
      .where(eq(companyStaffProfiles.companyId, companyId)),
  ]);

  const agentIds = new Set(agentRows.map((agent) => agent.id));
  const userIds = new Set(memberRows.map((member) => member.userId));
  const parents = new Map<string, string | null>();
  for (const agent of agentRows) {
    const selfKey = orgPrincipalKey({ type: "agent", id: agent.id });
    if (!selfKey) continue;
    const manager = agent.reportsToUserId
      ? resolveManagerKey({ type: "user", id: agent.reportsToUserId }, agentIds, userIds)
      : agent.reportsTo
        ? resolveManagerKey({ type: "agent", id: agent.reportsTo }, agentIds, userIds)
        : null;
    parents.set(selfKey, manager);
  }
  for (const profile of profileRows) {
    if (!userIds.has(profile.userId)) continue;
    const selfKey = orgPrincipalKey({ type: "user", id: profile.userId });
    if (!selfKey) continue;
    const manager = profile.reportsToPrincipalType && profile.reportsToPrincipalId
      ? resolveManagerKey({
        type: profile.reportsToPrincipalType as "agent" | "user",
        id: profile.reportsToPrincipalId,
      }, agentIds, userIds)
      : null;
    parents.set(selfKey, manager);
  }
  return parents;
}

function reportingEdgeCreatesCycle(
  parents: Map<string, string | null>,
  nodeKey: string,
  managerKey: string | null,
): boolean {
  const visited = new Set<string>();
  let current: string | null = managerKey;
  while (current) {
    if (current === nodeKey) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

export async function assertHybridReportingAcyclic(
  db: Db,
  companyId: string,
  node: OrgPrincipalRef,
  reportsTo: OrgPrincipalRef | null,
): Promise<void> {
  // Clearing a manager can never introduce a cycle.
  if (!reportsTo) return;
  const nodeKey = orgPrincipalKey(node);
  const managerKey = orgPrincipalKey(reportsTo);
  if (!nodeKey || !managerKey) return;
  if (nodeKey === managerKey) {
    throw badRequest("Reporting relationship would create a cycle in the org chart");
  }
  const parents = await loadReportingParentMap(db, companyId);
  if (reportingEdgeCreatesCycle(parents, nodeKey, managerKey)) {
    throw badRequest("Reporting relationship would create a cycle in the org chart");
  }
}
