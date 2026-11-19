import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companies, createDb, type Db } from "@paperclipai/db";
import { createAgentSchema, sendChatMessageSchema } from "@paperclipai/shared";
import { agentRoutes } from "../routes/agents.js";
import { accessService } from "../services/access.js";
import { assertAgentReportsToPrincipal, hybridOrgForCompany } from "../services/company-org.js";
import { assertHybridReportingAcyclic } from "../services/company-reporting-graph.js";
import { companyStaffProfileService } from "../services/company-staff-profiles.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("company org and staff", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("company-org-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("builds a hybrid org chart with humans and agents", async () => {
    const [company] = await db.insert(companies).values({ name: "Acorn", issuePrefix: "ACORN" }).returning();
    const now = new Date();
    const [humanCeo] = await db.insert(authUsers).values({ id: "ceo-user", email: "ceo@example.com", name: "Avery", image: "https://example.com/avery.png", createdAt: now, updatedAt: now }).returning();
    const [humanOps] = await db.insert(authUsers).values({ id: "ops-user", email: "ops@example.com", name: "Riley", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values([
      { companyId: company!.id, principalType: "user", principalId: humanCeo!.id, status: "active", membershipRole: "owner" },
      { companyId: company!.id, principalType: "user", principalId: humanOps!.id, status: "active", membershipRole: "operator" },
    ]);
    const [agentCoo] = await db.insert(agents).values({
      companyId: company!.id, name: "Morgan", role: "coo", title: "COO", adapterType: "process", reportsToUserId: humanCeo!.id,
    }).returning();
    await db.insert(agents).values({
      companyId: company!.id, name: "Jules", role: "engineer", title: "Engineer", adapterType: "process", reportsTo: agentCoo!.id,
    });
    await companyStaffProfileService(db).upsertForMember(company!.id, humanCeo!.id, {
      jobTitle: "Chief Executive",
      orgRole: "ceo",
      reportsTo: null,
    });
    await companyStaffProfileService(db).upsertForMember(company!.id, humanOps!.id, {
      jobTitle: "Operations",
      orgRole: "operator",
      reportsTo: { type: "user", id: humanCeo!.id },
    });

    const tree = await hybridOrgForCompany(db, company!.id);
    const ceo = tree.find((node) => node.kind === "user" && node.id === humanCeo!.id);
    expect(ceo).toMatchObject({ name: "Avery", role: "ceo", title: "Chief Executive", image: "https://example.com/avery.png" });
    expect(ceo?.reports.some((node) => node.kind === "user" && node.id === humanOps!.id)).toBe(true);
    expect(ceo?.reports.some((node) => node.kind === "agent" && node.id === agentCoo!.id)).toBe(true);
    const coo = ceo?.reports.find((node) => node.kind === "agent" && node.id === agentCoo!.id);
    expect(coo?.reports[0]).toMatchObject({ name: "Jules" });
  });

  it("allows agents to report to a human manager", async () => {
    const [company] = await db.insert(companies).values({ name: "Pine", issuePrefix: "PINE" }).returning();
    const now = new Date();
    const [humanLead] = await db.insert(authUsers).values({ id: "lead-user", email: "lead@example.com", name: "Lead", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: humanLead!.id, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process", reportsToUserId: humanLead!.id });
    const tree = await hybridOrgForCompany(db, company!.id);
    expect(tree[0]).toMatchObject({ kind: "user", id: humanLead!.id });
    expect(tree[0]?.reports[0]).toMatchObject({ kind: "agent", name: "Worker" });
  });

  it("accepts recipientUserId on send_chat_message", () => {
    expect(sendChatMessageSchema.safeParse({
      body: "Need your sign-off.",
      idempotencyKey: "staff-question",
      recipientUserId: "ops-user",
    }).success).toBe(true);
  });

  it("rejects reporting to both agent and human on create", () => {
    expect(createAgentSchema.safeParse({
      name: "Worker",
      adapterType: "process",
      reportsTo: "11111111-1111-4111-8111-111111111111",
      reportsToUserId: "lead-user",
    }).success).toBe(false);
  });

  it("accepts non-UUID human manager ids when validating reportsToUserId", async () => {
    const [company] = await db.insert(companies).values({ name: "Oak", issuePrefix: "OAK" }).returning();
    const now = new Date();
    const [humanLead] = await db.insert(authUsers).values({ id: "oak-lead", email: "lead2@example.com", name: "Lead", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: humanLead!.id, status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process" }).returning();
    await expect(assertAgentReportsToPrincipal(db, company!.id, agent!.id, null, humanLead!.id)).resolves.toBeUndefined();
  });

  it("rejects a human-and-agent reporting cycle", async () => {
    const [company] = await db.insert(companies).values({ name: "Maple", issuePrefix: "MAP" }).returning();
    const now = new Date();
    const [humanLead] = await db.insert(authUsers).values({ id: "lead-cycle", email: "cycle@example.com", name: "Lead", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: humanLead!.id, status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process", reportsToUserId: humanLead!.id,
    }).returning();
    await expect(companyStaffProfileService(db).upsertForMember(company!.id, humanLead!.id, {
      orgRole: "ceo",
      reportsTo: { type: "agent", id: agent!.id },
    })).rejects.toThrow("cycle");
  });

  it("rejects a cycle routed through a suspended member", async () => {
    const [company] = await db.insert(companies).values({ name: "Birch", issuePrefix: "BIR" }).returning();
    const [lead] = await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: "birch-lead", status: "active", membershipRole: "owner",
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process", reportsToUserId: "birch-lead",
    }).returning();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, lead!.id));
    await expect(companyStaffProfileService(db).upsertForMember(company!.id, "birch-lead", {
      reportsTo: { type: "agent", id: agent!.id },
    })).rejects.toThrow("cycle");
  });

  it("rejects an agent-to-agent edge that closes a cycle through a human", async () => {
    const [company] = await db.insert(companies).values({ name: "Cedar", issuePrefix: "CED" }).returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: "cedar-lead", status: "active", membershipRole: "owner",
    });
    const [agentA] = await db.insert(agents).values({ companyId: company!.id, name: "A", role: "engineer", adapterType: "process" }).returning();
    await companyStaffProfileService(db).upsertForMember(company!.id, "cedar-lead", {
      reportsTo: { type: "agent", id: agentA!.id },
    });
    const [agentB] = await db.insert(agents).values({
      companyId: company!.id, name: "B", role: "engineer", adapterType: "process", reportsToUserId: "cedar-lead",
    }).returning();
    await expect(assertAgentReportsToPrincipal(db, company!.id, agentA!.id, agentB!.id, null)).rejects.toThrow("cycle");
  });

  it("clears a manager without loading the reporting graph", async () => {
    const untouchableDb = new Proxy({}, {
      get() {
        throw new Error("clearing a manager must not query the database");
      },
    }) as Db;
    await expect(assertHybridReportingAcyclic(untouchableDb, "company", { type: "agent", id: "agent" }, null)).resolves.toBeUndefined();
  });

  it("checks reporting cycles with a fixed number of queries in a large company", async () => {
    const [company] = await db.insert(companies).values({ name: "Spruce", issuePrefix: "SPR" }).returning();
    const agentIds = Array.from({ length: 400 }, () => randomUUID());
    await db.insert(agents).values(agentIds.map((id, index) => ({
      id,
      companyId: company!.id,
      name: `Agent ${index}`,
      role: "engineer",
      adapterType: "process",
      reportsTo: index === 0 ? null : agentIds[index - 1],
    })));
    await db.insert(companyMemberships).values(Array.from({ length: 300 }, (_, index) => ({
      companyId: company!.id,
      principalType: "user",
      principalId: `spruce-member-${index}`,
      status: "active",
      membershipRole: "operator",
    })));

    let selectCount = 0;
    const countingDb = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "select" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          selectCount += 1;
          return value.apply(target, args);
        };
      },
    });

    const lastAgentId = agentIds[agentIds.length - 1]!;
    await expect(assertHybridReportingAcyclic(countingDb, company!.id, { type: "agent", id: agentIds[0]! }, { type: "agent", id: lastAgentId }))
      .rejects.toThrow("cycle");
    expect(selectCount).toBe(3);

    selectCount = 0;
    await expect(assertHybridReportingAcyclic(countingDb, company!.id, { type: "user", id: "spruce-member-0" }, { type: "agent", id: lastAgentId }))
      .resolves.toBeUndefined();
    expect(selectCount).toBe(3);
  });

  it("rolls back the membership change when the staff profile is invalid", async () => {
    const [company] = await db.insert(companies).values({ name: "Willow", issuePrefix: "WIL" }).returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: "willow-owner", status: "active", membershipRole: "owner",
    });
    const [member] = await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: "willow-member", status: "active", membershipRole: "operator",
    }).returning();

    await expect(accessService(db).updateMember(company!.id, member!.id, { status: "suspended" }, {
      afterUpdate: async (tx) => {
        await companyStaffProfileService(tx).upsertForMember(company!.id, "willow-member", {
          reportsTo: { type: "agent", id: randomUUID() },
        });
      },
    })).rejects.toThrow("Reports-to agent is not in this company");

    const [after] = await db.select().from(companyMemberships).where(eq(companyMemberships.id, member!.id));
    expect(after?.status).toBe("active");
    expect(await companyStaffProfileService(db).getForUser(company!.id, "willow-member")).toBeNull();
  });

  it("excludes suspended members from the org chart", async () => {
    const [company] = await db.insert(companies).values({ name: "Elm", issuePrefix: "ELM" }).returning();
    const now = new Date();
    const [human] = await db.insert(authUsers).values({ id: "suspended-user", email: "s@example.com", name: "Suspended", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: human!.id, status: "suspended", membershipRole: "operator" });
    const tree = await hybridOrgForCompany(db, company!.id);
    expect(tree.some((node) => node.kind === "user" && node.id === human!.id)).toBe(false);
  });

  it("returns human profile photos from the org API", async () => {
    const [company] = await db.insert(companies).values({ name: "Birch", issuePrefix: "BIRCH" }).returning();
    const now = new Date();
    const [lead] = await db.insert(authUsers).values({ id: "photo-lead", email: "lead@example.com", name: "Quinn", image: "https://example.com/quinn.png", createdAt: now, updatedAt: now }).returning();
    const [peer] = await db.insert(authUsers).values({ id: "photo-peer", email: "peer@example.com", name: "Sage", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values([
      { companyId: company!.id, principalType: "user", principalId: lead!.id, status: "active", membershipRole: "owner" },
      { companyId: company!.id, principalType: "user", principalId: peer!.id, status: "active", membershipRole: "member" },
    ]);
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Rowan", role: "engineer", adapterType: "process", reportsToUserId: lead!.id,
    }).returning();
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: lead!.id, companyIds: [company!.id] }; next(); });
    app.use("/api", agentRoutes(db));

    const response = await request(app).get(`/api/companies/${company!.id}/org`);

    expect(response.status).toBe(200);
    type OrgResponseNode = { id: string; kind: string; image?: string | null; reports: OrgResponseNode[] };
    const flatten = (nodes: OrgResponseNode[]): OrgResponseNode[] => nodes.flatMap((node) => [node, ...flatten(node.reports)]);
    const nodes = flatten(response.body as OrgResponseNode[]);
    expect(nodes.find((node) => node.kind === "user" && node.id === lead!.id)?.image).toBe("https://example.com/quinn.png");
    expect(nodes.find((node) => node.kind === "user" && node.id === peer!.id)).toHaveProperty("image", null);
    expect(nodes.find((node) => node.kind === "agent" && node.id === agent!.id)).not.toHaveProperty("image");
  });
});
