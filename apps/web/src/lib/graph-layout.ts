import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { GraphView } from './api';

/**
 * Where each node of the graph goes (graph design 6.1). `d3-force` lays it out once, ahead of
 * drawing: told relationships pull hard, shared stories gently, everyone pushes everyone away,
 * and the protagonist stays in the middle. A node with no line drifts to a ring at the edge, so
 * it is shown as standing alone. Seeded start positions: the same graph is drawn the same way.
 */
export interface Point {
  x: number;
  y: number;
}

interface SimNode {
  id: string;
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
  lone: boolean;
}

const TICKS = 300;

export function layout(
  view: GraphView,
  frame: { width: number; height: number },
): Map<string, Point> {
  const { width, height } = frame;
  const cx = width / 2;
  const cy = height / 2;
  // room for a node and the name under it
  const margin = 44;
  const joined = new Set<string>();
  for (const l of [...view.told, ...view.together]) {
    joined.add(l.a);
    joined.add(l.b);
  }
  const ring = Math.min(width, height) / 2 - margin;
  const nodes: SimNode[] = view.nodes.map((n, i) => {
    // the start: around a circle, in the order given, so every run begins alike
    const a = (i / Math.max(1, view.nodes.length)) * 2 * Math.PI;
    const r = ring * 0.5;
    const node: SimNode = {
      id: n.id,
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r,
      lone: !joined.has(n.id) && !n.subject,
    };
    if (n.subject) {
      node.fx = cx;
      node.fy = cy;
      node.x = cx;
      node.y = cy;
    }
    return node;
  });
  const known = new Set(nodes.map((n) => n.id));
  const links = [
    ...view.told.map((l) => ({ source: l.a, target: l.b, strength: 0.9, distance: 70 })),
    ...view.together.map((l) => ({ source: l.a, target: l.b, strength: 0.15, distance: 110 })),
  ].filter((l) => known.has(l.source) && known.has(l.target));

  const sim = forceSimulation(nodes)
    .randomSource(seeded(7))
    .force(
      'link',
      forceLink<
        SimNode,
        (typeof links)[number] & { source: string | SimNode; target: string | SimNode }
      >(links)
        .id((n) => n.id)
        .strength((l) => l.strength)
        .distance((l) => l.distance),
    )
    .force('charge', forceManyBody<SimNode>().strength(-220))
    .force('collide', forceCollide<SimNode>(30))
    .force(
      'x',
      forceX<SimNode>(cx).strength((n) => (n.lone ? 0 : 0.04)),
    )
    .force(
      'y',
      forceY<SimNode>(cy).strength((n) => (n.lone ? 0 : 0.06)),
    )
    .force('ring', ringForce(cx, cy, ring))
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();

  // scaled out from the middle to fill the frame (at most 2.5 times), the protagonist staying put
  let reach = 0;
  for (const n of nodes) {
    reach = Math.max(reach, Math.abs(n.x - cx) / (cx - margin), Math.abs(n.y - cy) / (cy - margin));
  }
  const k = reach > 0 ? Math.min(2.5, 1 / reach) : 1;
  const at = new Map<string, Point>();
  for (const n of nodes) {
    at.set(n.id, {
      x: n.fx != null ? n.fx : clamp(cx + (n.x - cx) * k, margin, width - margin),
      y: n.fy != null ? n.fy : clamp(cy + (n.y - cy) * k, margin, height - margin),
    });
  }
  return at;
}

/** a node with no line is drawn to a ring near the edge */
function ringForce(cx: number, cy: number, r: number) {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    for (const n of nodes) {
      if (!n.lone) continue;
      const dx = n.x - cx;
      const dy = n.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const k = ((r - d) / d) * alpha * 0.5;
      n.x += dx * k;
      n.y += dy * k;
    }
  };
  force.initialize = (ns: SimNode[]) => {
    nodes = ns;
  };
  return force;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
