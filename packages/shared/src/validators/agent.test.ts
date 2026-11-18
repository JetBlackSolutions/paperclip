import { describe, expect, it } from "vitest";
import { updateAgentBodySchema, updateAgentSchema } from "./agent.js";

describe("agent update schema", () => {
  it.each(["paused", "idle", "terminated"])("accepts lifecycle status request %s", status => {
    expect(updateAgentSchema.parse({ status })).toEqual({ status });
  });
  it.each(["active", "running", "error", "pending_approval"])("rejects direct status write %s", status => {
    const result = updateAgentSchema.safeParse({ name: "Renamed", status });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["status"] }),
    ]));
  });
  it.each([{ spentMonthlyCents: 0 }, { name: "Renamed", spentMonthlyCents: 10 }])("rejects spend totals: %j", payload => {
    const result = updateAgentSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["spentMonthlyCents"] }),
    ]));
  });
  it("accepts profile and budget limit changes", () => {
    expect(updateAgentSchema.parse({ name: "Renamed", budgetMonthlyCents: 100 })).toEqual({ name: "Renamed", budgetMonthlyCents: 100 });
  });
  it("rejects reporting to both an agent and a human", () => {
    const result = updateAgentSchema.safeParse({
      reportsTo: "11111111-1111-4111-8111-111111111111",
      reportsToUserId: "user-1",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["reportsTo"] }),
    ]));
  });
  it("exposes an unrefined body schema that supports pick and omit", () => {
    expect(() => updateAgentBodySchema.pick({ name: true, reportsTo: true })).not.toThrow();
    expect(() => updateAgentBodySchema.omit({ permissions: true, spentMonthlyCents: true })).not.toThrow();
  });
});
