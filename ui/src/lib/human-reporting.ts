import type { OrgNode } from "@/api/agents";

/** Use typed principal keys: an agent and a member can have the same raw ID. */
export function humanReportingOptions(tree: OrgNode[], agentId: string) {
  const humans: OrgNode[] = [];
  const blockedAgents: string[] = [];
  const blockedHumans: string[] = [];
  const visit = (nodes: OrgNode[], belowSelf = false) => {
    for (const node of nodes) {
      const isHuman = node.kind === "user";
      const blocked = belowSelf || (!isHuman && node.id === agentId);
      if (isHuman) humans.push(node);
      if (blocked) (isHuman ? blockedHumans : blockedAgents).push(node.id);
      visit(node.reports, blocked);
    }
  };
  visit(tree);
  return { humans, blockedAgents, blockedHumans };
}

export function reportingManagerPatch(type: "agent" | "user", id: string | null) {
  return { reportsTo: type === "agent" ? id : null, reportsToUserId: type === "user" ? id : null };
}
