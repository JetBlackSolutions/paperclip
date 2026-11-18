import { describe, expect, it } from "vitest";
import { humanReportingOptions, reportingManagerPatch } from "./human-reporting";
import type { OrgNode } from "@/api/agents";
const node = (id: string, kind: "agent" | "user", reports: OrgNode[] = []): OrgNode => ({ id, kind, name: id, role: "general", status: "active", reports });
describe("human reporting", () => {
  it("blocks mixed descendants without confusing human and agent IDs", () => {
    const result = humanReportingOptions([node("same", "user"), node("same", "agent", [node("human-child", "user", [node("bot-child", "agent")])])], "same");
    expect(result.humans.map(h => h.id)).toEqual(["same", "human-child"]);
    expect(result.blockedHumans).toEqual(["human-child"]);
    expect(result.blockedAgents).toEqual(["same", "bot-child"]);
  });
  it("clears the other manager type on change or removal", () => {
    expect(reportingManagerPatch("user", "human")).toEqual({ reportsTo: null, reportsToUserId: "human" });
    expect(reportingManagerPatch("agent", "bot")).toEqual({ reportsTo: "bot", reportsToUserId: null });
    expect(reportingManagerPatch("agent", null)).toEqual({ reportsTo: null, reportsToUserId: null });
  });
});
