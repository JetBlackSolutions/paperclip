import { describe, expect, it, vi, beforeEach } from "vitest";
import { heartbeatRuns, issueComments } from "@paperclipai/db";

const loadRunBoundIssue = vi.hoisted(() => vi.fn());
vi.mock("../services/issue-creation-source.js", () => ({ loadRunBoundIssue }));

const { agentPersonInCompany } = await import("../routes/agent-person-authz.js");

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const commentId = "44444444-4444-4444-8444-444444444444";
const person = "person-1";

/** A database that answers the two reads the rule makes: the run, then the waking comment. */
function fakeDb(input: { run?: Record<string, unknown> | null; commentByPerson?: boolean }) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === heartbeatRuns
            ? (input.run ? [input.run] : [])
            : table === issueComments && input.commentByPerson ? [{ id: commentId }] : [];
          return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
        },
      }),
    }),
  } as never;
}

function agentRequest(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      type: "agent", agentId, companyId, runId, onBehalfOfUserId: person,
      onBehalfOfMemberships: [{ companyId, status: "active", membershipRole: "owner" }],
      ...overrides,
    },
  } as never;
}

const run = (contextSnapshot: Record<string, unknown> = {}) => ({ companyId, issueId: null, nativeIssueId: null, contextSnapshot });

describe("agentPersonInCompany", () => {
  beforeEach(() => loadRunBoundIssue.mockReset().mockResolvedValue(null));

  it("acts for the person when their message woke the run", async () => {
    const db = fakeDb({ run: run({ wakeCommentId: commentId }), commentByPerson: true });
    expect(await agentPersonInCompany(db, agentRequest(), companyId)).toEqual({ userId: person, role: "owner" });
  });

  it("acts for the person when the run's own task is one they made, such as their chat", async () => {
    loadRunBoundIssue.mockResolvedValue({ createdByUserId: person });
    expect(await agentPersonInCompany(fakeDb({ run: run() }), agentRequest(), companyId)).toEqual({ userId: person, role: "owner" });
  });

  it("does not borrow the person's authority on a run they did not direct, such as a routine timer", async () => {
    loadRunBoundIssue.mockResolvedValue({ createdByUserId: "someone-else" });
    expect(await agentPersonInCompany(fakeDb({ run: run({ wakeCommentId: commentId }), commentByPerson: false }), agentRequest(), companyId)).toBeNull();
  });

  it("refuses without an active membership in this company, or for a person-less run", async () => {
    loadRunBoundIssue.mockResolvedValue({ createdByUserId: person });
    const db = fakeDb({ run: run() });
    expect(await agentPersonInCompany(db, agentRequest({ onBehalfOfMemberships: [{ companyId, status: "suspended" }] }), companyId)).toBeNull();
    expect(await agentPersonInCompany(db, agentRequest({ onBehalfOfMemberships: [{ companyId: "other", status: "active" }] }), companyId)).toBeNull();
    expect(await agentPersonInCompany(db, agentRequest({ onBehalfOfUserId: null }), companyId)).toBeNull();
    expect(await agentPersonInCompany(db, { actor: { type: "board", userId: person } } as never, companyId)).toBeNull();
  });

  it("refuses a run that belongs to another company", async () => {
    loadRunBoundIssue.mockResolvedValue({ createdByUserId: person });
    const db = fakeDb({ run: { ...run(), companyId: "55555555-5555-4555-8555-555555555555" } });
    expect(await agentPersonInCompany(db, agentRequest(), companyId)).toBeNull();
  });
});
