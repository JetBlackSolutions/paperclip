import { describe, expect, it } from "vitest";
import { layoutOrganization, routeReportingEdges, type LayoutNode, type ChartGeometry } from "./layout";
import type { OrgNode } from "../../api/agents";
const geometry: ChartGeometry = { leaderWidth: 280, leaderHeight: 368, managerWidth: 232, managerHeight: 320, memberWidth: 192, memberHeight: 116, gap: 32, levelGap: 72, padding: 48, taskHeight: 32, sparsePadding: 80, fitZoomMax: 1.25, sparseFitZoomMax: 1 };
const node = (id: string, reports: OrgNode[] = []): OrgNode => ({ id, name: id, role: "general", status: "idle", reports });
function flatten(roots: LayoutNode[]): LayoutNode[] { return roots.flatMap(root => [root, ...flatten(root.children)]); }
describe("compact organization layout", () => {
  it("spreads broad teams, cascades leaders, and keeps every card separate", () => {
    const tree = [node("ceo", [node("cto", Array.from({ length: 12 }, (_, i) => node(`eng-${i}`))), node("cmo", Array.from({ length: 4 }, (_, i) => node(`mkt-${i}`))), node("staff")])];
    for (const viewport of [{ width: 1500, height: 900 }, { width: 390, height: 750 }]) {
      const result = layoutOrganization(tree, viewport, geometry);
      const nodes = flatten(result.roots);
      expect(nodes).toHaveLength(20);
      const byId = new Map(nodes.map(n => [n.id, n]));
      expect(byId.get("ceo")!.width).toBeGreaterThan(byId.get("cto")!.width);
      expect(byId.get("cto")!.height).toBeGreaterThan(byId.get("eng-0")!.height);
      expect(new Set(nodes.filter(n => n.id.startsWith("eng-")).map(n => n.y)).size).toBeGreaterThan(1);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
      const scale = Math.min(viewport.width / result.width, viewport.height / result.height);
      expect(result.height * scale).toBeGreaterThan(viewport.height * 0.65);
    }
  });
  it("keeps a mixed team's ICs beside its leaders", () => {
    const tree = [node("ceo", [
      node("cto", Array.from({ length: 12 }, (_, i) => node(`eng-${i}`))),
      node("cmo", Array.from({ length: 4 }, (_, i) => node(`mkt-${i}`))),
      ...Array.from({ length: 4 }, (_, i) => node(`staff-${i}`)),
    ])];
    const result = layoutOrganization(tree, { width: 1500, height: 900 }, geometry);
    const nodes = flatten(result.roots);
    const cto = nodes.find(n => n.id === "cto")!;
    expect(nodes.find(n => n.id === "staff-0")!.y).toBe(cto.y);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const aBottom = a.y + a.height;
      const bBottom = b.y + b.height;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || aBottom <= b.y || bBottom <= a.y).toBe(true);
    }
  });
  it("routes teams from a shared bus and stacked reports from a side rail, outside every card", () => {
    const tree = [node("ceo", [node("cmo", Array.from({ length: 4 }, (_, i) => node(`mkt-${i}`))), node("cto", Array.from({ length: 12 }, (_, i) => node(`eng-${i}`))), ...Array.from({ length: 4 }, (_, i) => node(`staff-${i}`))])];
    for (const viewport of [{ width: 1500, height: 900 }, { width: 390, height: 750 }]) {
      const result = layoutOrganization(tree, viewport, geometry);
      const nodes = flatten(result.roots);
      const routes = routeReportingEdges(result.roots, geometry.gap);
      expect(routes).toHaveLength(nodes.length - 1);
      const segments = routes.flatMap(route => route.points.slice(1).map((end, i) => ({ start: route.points[i], end })));
      for (const segment of segments) {
        const { start: a, end: b } = segment;
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const card of nodes) {
          const inside = a.x === b.x
            ? a.x > card.x && a.x < card.x + card.width && Math.max(a.y, b.y) > card.y && Math.min(a.y, b.y) < card.y + card.height
            : a.y > card.y && a.y < card.y + card.height && Math.max(a.x, b.x) > card.x && Math.min(a.x, b.x) < card.x + card.width;
          expect(inside, `Line crosses ${card.id}`).toBe(false);
        }
      }
      for (const { child, points } of routes) {
        const end = points.at(-1)!;
        const entersTop = end.x === child.x + child.width / 2 && end.y === child.y;
        const entersSide = end.x === child.x && end.y === child.y + child.height / 2;
        expect(entersTop || entersSide, `Line to ${child.id} ends at a card edge`).toBe(true);
      }
      const ceo = nodes.find(n => n.id === "ceo")!;
      const firstRow = Math.min(...ceo.children.map(child => child.y));
      for (const team of ceo.children.filter(child => child.leader && child.y === firstRow)) {
        expect(routes.find(route => route.child === team)!.points.at(-1)).toEqual({ x: team.x + team.width / 2, y: team.y });
      }
    }
  });
  it("stacks a lead's individual contributors in one indented column under it", () => {
    const tree = [node("ceo", [node("lead", Array.from({ length: 5 }, (_, i) => node(`agent-${i}`))), node("other", [node("solo")])])];
    const lead = flatten(layoutOrganization(tree, { width: 1500, height: 900 }, geometry).roots).find(n => n.id === "lead")!;
    expect(new Set(lead.children.map(child => child.x))).toEqual(new Set([lead.x + geometry.gap]));
    lead.children.forEach((child, i) => {
      const above = i ? lead.children[i - 1] : lead;
      expect(child.y).toBeGreaterThanOrEqual(above.y + above.height);
    });
  });
  it("uses exactly three stable tiers, including deeper leads and root-level contributors", () => {
    const tree = [node("ceo", [node("cto", [node("team-lead", [node("engineer")])]), node("staff")]), node("independent")];
    for (const viewport of [{ width: 1500, height: 900 }, { width: 2400, height: 1600 }, { width: 390, height: 750 }]) {
      const nodes = new Map(flatten(layoutOrganization(tree, viewport, geometry).roots).map(n => [n.id, n]));
      expect(nodes.get("ceo")).toMatchObject({ tier: 1, width: geometry.leaderWidth, height: geometry.leaderHeight });
      for (const id of ["cto", "team-lead"]) expect(nodes.get(id)).toMatchObject({ tier: 2, width: geometry.managerWidth, height: geometry.managerHeight });
      for (const id of ["engineer", "staff", "independent"]) expect(nodes.get(id)).toMatchObject({ tier: 3, width: geometry.memberWidth, height: geometry.memberHeight });
      for (const leader of [...nodes.values()].filter(n => n.leader)) expect(leader.height).toBeGreaterThan(leader.width);
    }
  });
  it("caps sparse organizations at natural size with generous, symmetric padding", () => {
    for (const tree of [[node("solo")], [node("lead", [node("report")])], [node("first"), node("second")]]) {
      const result = layoutOrganization(tree, { width: 2400, height: 1600 }, geometry);
      const nodes = flatten(result.roots);
      expect(result.maxFitZoom).toBe(1);
      expect(Math.min(...nodes.map(n => n.x))).toBe(geometry.sparsePadding);
      expect(Math.min(...nodes.map(n => n.y))).toBe(geometry.sparsePadding);
      expect(result.width - Math.max(...nodes.map(n => n.x + n.width))).toBe(geometry.sparsePadding);
      expect(result.height - Math.max(...nodes.map(n => n.y + n.height))).toBe(geometry.sparsePadding);
      expect(nodes[0].width).toBe(nodes[0].leader ? geometry.leaderWidth : geometry.memberWidth);
    }
  });
  it("handles a large roster without revisiting source subtrees quadratically", () => {
    let reads = 0;
    const root = node("root", Array.from({ length: 500 }, (_, i) => node(`agent-${i}`)));
    const reports = root.reports;
    Object.defineProperty(root, "reports", { get: () => { reads++; if (reads > 30) throw new Error("Repeated subtree scan"); return reports; } });
    const result = layoutOrganization([root], { width: 1500, height: 900 }, geometry);
    expect(flatten(result.roots)).toHaveLength(501);
    expect(reads).toBeLessThanOrEqual(18);
  });
});

it("preserves human profile photos through layout", () => {
  const result = layoutOrganization([{ ...node("human"), kind: "user", image: "/api/assets/photo/content" }], { width: 800, height: 600 }, geometry);
  expect(result.roots[0]).toMatchObject({ kind: "user", image: "/api/assets/photo/content" });
});

it("gives humans the same card tier as department heads even without reports", () => {
  const result = layoutOrganization([{ ...node("owner", [{ ...node("person"), kind: "user" }, node("lead", [node("bot")])]), kind: "user" }], { width: 1500, height: 900 }, geometry);
  const nodes = new Map(flatten(result.roots).map(n => [n.id, n]));
  expect(nodes.get("owner")).toMatchObject({ tier: 1, width: geometry.leaderWidth, height: geometry.leaderHeight });
  expect(nodes.get("person")).toMatchObject({ tier: 2, width: geometry.managerWidth, height: geometry.managerHeight });
});

it("keeps a manager's teams in one row instead of one tall column", () => {
  // Shaped like a real 50-agent company: one owner over eight agent teams.
  const tree = [{ ...node("owner", Array.from({ length: 8 }, (_, t) =>
    node(`lead-${t}`, Array.from({ length: 5 }, (_, i) => node(`agent-${t}-${i}`))))), kind: "user" as const }];
  const result = layoutOrganization(tree, { width: 1500, height: 900 }, geometry);
  expect(new Set(result.roots[0].children.map(team => team.y)).size).toBe(1);
  expect(new Set(result.roots[0].children.map(team => team.x)).size).toBeGreaterThan(1);
  expect(result.height / result.width).toBeLessThan(3);
});
