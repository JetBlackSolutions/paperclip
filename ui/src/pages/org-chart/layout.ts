import type { OrgNode } from "../../api/agents";

export interface ChartGeometry {
  leaderWidth: number; leaderHeight: number;
  managerWidth: number; managerHeight: number;
  memberWidth: number; memberHeight: number;
  gap: number; levelGap: number; padding: number; taskHeight: number;
  sparsePadding: number; fitZoomMax: number; sparseFitZoomMax: number;
}
export interface LayoutNode {
  id: string;
  kind?: OrgNode["kind"];
  image?: string | null;
  title?: string | null;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  tier: 1 | 2 | 3;
  leader: boolean;
  children: LayoutNode[];
  offsetX?: number;
  offsetY?: number;
}
interface Block { roots: LayoutNode[]; width: number; height: number }
function shift(node: LayoutNode, x: number, y: number) {
  node.offsetX = (node.offsetX ?? 0) + x;
  node.offsetY = (node.offsetY ?? 0) + y;
}
function resolvePositions(node: LayoutNode, x = 0, y = 0) {
  x += node.offsetX ?? 0; y += node.offsetY ?? 0;
  node.x += x; node.y += y;
  node.children.forEach(child => resolvePositions(child, x, y));
  delete node.offsetX; delete node.offsetY;
}
function pack(blocks: Block[], columns: number, gap: number): Block {
  const rows: Block[][] = [];
  for (let i = 0; i < blocks.length; i += columns) rows.push(blocks.slice(i, i + columns));
  const width = Math.max(0, ...rows.map(row => row.reduce((sum, b) => sum + b.width, 0) + (row.length - 1) * gap));
  let y = 0;
  const roots: LayoutNode[] = [];
  for (const row of rows) {
    // Keep partial rows aligned so connector lanes stay between columns.
    let x = 0;
    for (const block of row) {
      block.roots.forEach(node => { shift(node, x, y); roots.push(node); });
      x += block.width + gap;
    }
    y += Math.max(...row.map(b => b.height)) + gap;
  }
  return { roots, width, height: Math.max(0, y - gap) };
}

/** Pack three fixed card tiers; keep source traversal and packing passes bounded. */
export function layoutOrganization(roots: OrgNode[], viewport: { width: number; height: number }, g: ChartGeometry): Block & { maxFitZoom: number } {
  let count = 0;
  const snapshot = (node: OrgNode): OrgNode => {
    count++;
    const { reports, ...fields } = node;
    return { ...fields, reports: reports.map(snapshot) };
  };
  const source = roots.map(snapshot);
  // Small organizations should feel centered and roomy, not like oversized posters.
  const density = Math.min(1, Math.max(0, (count - 4) / 8));
  const padding = g.sparsePadding + (g.padding - g.sparsePadding) * density;
  const maxFitZoom = g.sparseFitZoomMax + (g.fitZoomMax - g.sparseFitZoomMax) * density;
  if (!source.length) return { roots: [], width: 0, height: 0, maxFitZoom };
  const availableWidth = Math.max(1, viewport.width - g.padding);
  const availableHeight = Math.max(1, viewport.height - g.padding);
  const fitScale = (block: Block) => Math.min(availableWidth / block.width, availableHeight / block.height, maxFitZoom);
  const arrange = (columns: number): Block => {
    const build = (node: OrgNode, depth: number): Block => {
      const reports = node.reports;
      const leader = reports.length > 0;
      const tier = !leader && node.kind !== "user" ? 3 : depth === 0 ? 1 : 2;
      const width = tier === 1 ? g.leaderWidth : tier === 2 ? g.managerWidth : g.memberWidth;
      const height = tier === 1 ? g.leaderHeight : tier === 2 ? g.managerHeight : g.memberHeight;
      const childBlocks = reports.map(child => build(child, depth + 1));
      const teams = childBlocks.filter(block => block.roots[0].leader);
      const members = childBlocks.filter(block => !block.roots[0].leader);
      const card = (x: number, children: LayoutNode[]): LayoutNode => ({
        id: node.id, kind: node.kind, image: node.image, title: node.title, name: node.name,
        role: node.role, status: node.status, x, y: 0, width, height, depth, tier, leader, children,
      });
      // A lead's individual contributors read as a list: one column indented
      // under the lead, joined by a rail in the gutter on its left. Teams sit
      // side by side and wrap to the viewport, because stacking whole teams
      // turned a 50-agent company into an unreadable sliver.
      if (!teams.length && members.length) {
        const column = pack(members, 1, g.gap);
        column.roots.forEach(child => shift(child, g.gap, height + g.gap));
        return {
          roots: [card(0, column.roots)],
          width: Math.max(width, g.gap + column.width),
          height: height + g.gap + column.height,
        };
      }
      // A mixed leadership team keeps its individual contributors in a compact
      // side column, instead of placing them below the deepest reporting branch.
      // The column leads the row so it never wraps under a tall team, where its
      // reporting line would have to run the length of that team.
      const branches = teams.length && members.length
        ? [pack(members, 1, g.gap), ...teams]
        : childBlocks;
      // Teams share one row under their manager, as in a conventional org chart:
      // a wrapped team would sit under a sibling's subtree with a line running
      // its full length. Only the top level wraps to fit the viewport.
      const children = pack(branches, branches.length, g.gap);
      const blockWidth = Math.max(width, children.width);
      children.roots.forEach(child => shift(child, (blockWidth - children.width) / 2, height + g.levelGap));
      return {
        roots: [card((blockWidth - width) / 2, children.roots)],
        width: blockWidth,
        height: height + (children.roots.length ? g.levelGap + children.height : 0),
      };
    };
    const candidate = pack(source.map(root => build(root, 0)), columns, g.levelGap);
    return { ...candidate, width: candidate.width + padding * 2, height: candidate.height + padding * 2 };
  };
  let best = arrange(1);
  let bestScore = -Infinity;
  for (let columns = 1; columns <= 6; columns++) {
    const candidate = columns === 1 ? best : arrange(columns);
    const scale = fitScale(candidate);
    const coverage = candidate.width * candidate.height * scale * scale / Math.max(1, viewport.width * viewport.height);
    const score = scale * (0.8 + coverage * 0.2);
    if (score > bestScore) {
      best = candidate; bestScore = score;
    }
  }
  best.roots.forEach(root => { shift(root, padding, padding); resolvePositions(root); });
  return { ...best, maxFitZoom };
}

export interface ReportingRoute {
  parent: LayoutNode;
  child: LayoutNode;
  points: Array<{ x: number; y: number }>;
  path: string;
}

/**
 * Draw reporting lines as an org chart: teams in the first row below their
 * manager hang from one shared bus and are entered from the top; stacked
 * reports (a lead's list, a side column, or a wrapped row) hang from a rail in
 * the gutter on their left and are entered from the side.
 */
export function routeReportingEdges(roots: LayoutNode[], gap: number): ReportingRoute[] {
  const routes: ReportingRoute[] = [];
  const visit = (parent: LayoutNode) => {
    if (!parent.children.length) return;
    const perColumn = new Map<number, number>();
    for (const child of parent.children) perColumn.set(child.x, (perColumn.get(child.x) ?? 0) + 1);
    const bottom = parent.y + parent.height;
    const firstRow = Math.min(...parent.children.map(child => child.y));
    const busY = bottom + (firstRow - bottom) / 2;
    const center = parent.x + parent.width / 2;
    for (const child of parent.children) {
      let points: Array<{ x: number; y: number }>;
      if (child.y === firstRow && perColumn.get(child.x) === 1) {
        const top = child.x + child.width / 2;
        points = [{ x: center, y: bottom }, { x: center, y: busY }, { x: top, y: busY }, { x: top, y: child.y }];
      } else {
        const rail = child.x - gap / 2;
        const endY = child.y + child.height / 2;
        points = rail > parent.x && rail < parent.x + parent.width
          ? [{ x: rail, y: bottom }, { x: rail, y: endY }, { x: child.x, y: endY }]
          : [{ x: center, y: bottom }, { x: center, y: busY }, { x: rail, y: busY }, { x: rail, y: endY }, { x: child.x, y: endY }];
      }
      routes.push({ parent, child, points, path: points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ") });
    }
    parent.children.forEach(visit);
  };
  roots.forEach(visit);
  return routes;
}
