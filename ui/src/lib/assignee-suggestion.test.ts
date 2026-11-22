import { describe, expect, it } from "vitest";
import { directLeadOf, shortlistAgents, suggestAssignee, type SuggestionAgent, type SuggestionRoutine } from "./assignee-suggestion";

const agents: SuggestionAgent[] = [
  { id: "ceo", name: "Jet", title: "Chief of Staff" },
  { id: "fin-lead", name: "Ledger", title: "Finance Lead", reportsTo: "ceo" },
  { id: "invoice", name: "Penny", title: "Invoice Specialist", reportsTo: "fin-lead" },
  { id: "payroll", name: "Paige", title: "Payroll Specialist", reportsTo: "fin-lead" },
  { id: "web-lead", name: "Atlas", title: "Web Delivery Lead", reportsTo: "ceo" },
  { id: "wp", name: "Quill", title: "WordPress Developer", reportsTo: "web-lead" },
  { id: "seo", name: "Scout", title: "SEO Analyst", reportsToUserId: "user-erin" },
  { id: "ads", name: "Echo", title: "Ads Analyst", reportsToUserId: "user-erin" },
];

const routines: SuggestionRoutine[] = [
  { assigneeAgentId: "invoice", title: "Chase overdue invoices", description: "Email clients about unpaid invoices every Monday." },
  { assigneeAgentId: "payroll", title: "Prepare contractor payroll", description: "Collect hours and prepare the payroll run." },
  { assigneeAgentId: "wp", title: "Plugin updates", description: "Update WordPress plugins and check the staging site." },
  { assigneeAgentId: "seo", title: "Weekly keyword report", description: "Report keyword rankings and organic traffic." },
  { assigneeAgentId: "ads", title: "Weekly campaign report", description: "Report ad spend and campaign results." },
];

const suggest = (text: string, extra: Partial<Parameters<typeof suggestAssignee>[0]> = {}) =>
  suggestAssignee({ text, agents, routines, assignableUserIds: ["user-erin"], ...extra });

describe("suggestAssignee", () => {
  it("picks the one specialist whose title matches", () => {
    const result = suggest("Update the WordPress theme on the client site");
    expect(result).toMatchObject({ target: { kind: "agent", id: "wp" }, reason: "specialist", matchedAgentIds: ["wp"] });
    expect(result?.matchedWords).toContain("WordPress");
  });

  it("offers the specialist's direct lead as the alternative", () => {
    expect(suggest("Update the WordPress theme on the client site")?.lead).toEqual({ kind: "agent", id: "web-lead" });
  });

  it("offers a human lead when the specialist reports to a person", () => {
    expect(suggest("Check keyword rankings for the new landing page")).toMatchObject({
      target: { kind: "agent", id: "seo" },
      lead: { kind: "user", id: "user-erin" },
    });
  });

  it("does not offer a human lead who cannot be assigned tasks", () => {
    expect(suggest("Check keyword rankings for the new landing page", { assignableUserIds: [] })?.lead).toBeNull();
  });

  it("matches on what an agent's routines cover, not only its title", () => {
    expect(suggest("Email the clients about unpaid balances")?.target).toEqual({ kind: "agent", id: "invoice" });
  });

  it("matches word forms: invoicing, invoices and invoice", () => {
    expect(suggest("Set up invoicing reminders for March")?.target).toEqual({ kind: "agent", id: "invoice" });
  });

  it("sends a request that fits several reports to the lead they share", () => {
    const result = suggest("Review invoice and payroll totals before month end");
    expect(result).toMatchObject({ target: { kind: "agent", id: "fin-lead" }, reason: "lead" });
    expect(result?.matchedAgentIds.sort()).toEqual(["invoice", "payroll"]);
  });

  it("sends a request that fits several agents to the person they all report to", () => {
    const result = suggest("Put together the weekly report for the client");
    expect(result).toMatchObject({ target: { kind: "user", id: "user-erin" }, reason: "lead" });
    expect(result?.matchedAgentIds.sort()).toEqual(["ads", "seo"]);
  });

  it("keeps the best specialist when the matching agents share no lead", () => {
    const flat: SuggestionAgent[] = [
      { id: "a", name: "Ada", title: "Report Writer" },
      { id: "b", name: "Bo", title: "Report Editor" },
    ];
    expect(suggestAssignee({ text: "Draft the quarterly report writer notes", agents: flat })).toMatchObject({
      target: { kind: "agent", id: "a" },
      reason: "specialist",
    });
  });

  it("suggests nothing when equal matches share no lead", () => {
    const flat: SuggestionAgent[] = [
      { id: "a", name: "Ada", title: "Report Writer" },
      { id: "b", name: "Bo", title: "Report Writer" },
    ];
    expect(suggestAssignee({ text: "Draft the quarterly report", agents: flat })).toBeNull();
  });

  it("treats a lead that matches alongside its own report as the shared lead", () => {
    const result = suggest("Finance review of the invoice backlog");
    expect(result).toMatchObject({ target: { kind: "agent", id: "fin-lead" }, reason: "lead", matchedAgentIds: ["invoice"] });
  });

  it("names only the words that carried the match", () => {
    expect(suggest("Update the WordPress theme on the client site")?.matchedWords).toEqual(["WordPress"]);
  });

  it("brings 'analyze' and 'analysis' together", () => {
    const analysts: SuggestionAgent[] = [{ id: "a", name: "Cam", title: "Campaign analysis" }, { id: "b", name: "Bo", title: "Bookkeeper" }];
    expect(suggestAssignee({ text: "Analyze the spring results", agents: analysts })?.target).toEqual({ kind: "agent", id: "a" });
  });

  it("does not decide on one word that only a routine mentions", () => {
    expect(suggest("Rebuild the staging environment tonight")).toBeNull();
  });

  it("never suggests an agent that would not start work", () => {
    expect(suggest("Update the WordPress theme on the client site", { unavailableAgentIds: ["wp"] })).toBeNull();
  });

  it("still sends a request to the shared lead when one of the matching reports would not start work", () => {
    expect(suggest("Review invoice and payroll totals before month end", { unavailableAgentIds: ["payroll"] }))
      .toMatchObject({ target: { kind: "agent", id: "fin-lead" }, reason: "lead" });
  });

  it("does not route to a lead that would not start work", () => {
    const result = suggest("Review invoice and payroll totals before month end", { unavailableAgentIds: ["fin-lead"] });
    expect(result?.target).toEqual({ kind: "agent", id: "ceo" });
    expect(suggest("Set up invoicing reminders for March", { unavailableAgentIds: ["fin-lead"] })?.lead).toBeNull();
  });

  it("suggests nothing for a request too short to judge", () => {
    expect(suggest("WordPress")).toBeNull();
    expect(suggest("please do this for me")).toBeNull();
  });

  it("suggests nothing when no agent's records match", () => {
    expect(suggest("Book flights and a hotel for the conference")).toBeNull();
  });

  it("suggests nothing when the only match is one passing word in a routine description", () => {
    expect(suggest("Remind everyone that Monday is a holiday and the office is closed")).toBeNull();
  });

  it("ignores archived routines", () => {
    const archived = routines.map((routine) => ({ ...routine, status: "archived" }));
    expect(suggest("Email the clients about unpaid balances", { routines: archived })).toBeNull();
  });


  it("survives a reporting loop", () => {
    const loop: SuggestionAgent[] = [
      { id: "a", name: "Ada", title: "Invoice Clerk", reportsTo: "b" },
      { id: "b", name: "Bo", title: "Invoice Auditor", reportsTo: "a" },
    ];
    expect(() => suggestAssignee({ text: "Check the invoice totals again", agents: loop })).not.toThrow();
  });
});

describe("shortlistAgents", () => {
  it("puts word matches first, then their leads, then the top of the company", () => {
    const ids = shortlistAgents({ text: "Fix the WordPress plugin", agents, routines }, 4);
    expect(ids.slice(0, 2)).toEqual(["wp", "web-lead"]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("still offers candidates when no word matches", () => {
    expect(shortlistAgents({ text: "Book flights", agents, routines }, 3)).toHaveLength(3);
  });
});

describe("directLeadOf", () => {
  it("returns the agent lead, or an assignable person, or nothing", () => {
    expect(directLeadOf("wp", agents)).toEqual({ kind: "agent", id: "web-lead" });
    expect(directLeadOf("seo", agents, ["user-erin"])).toEqual({ kind: "user", id: "user-erin" });
    expect(directLeadOf("seo", agents)).toBeNull();
    expect(directLeadOf("ceo", agents)).toBeNull();
  });
});
