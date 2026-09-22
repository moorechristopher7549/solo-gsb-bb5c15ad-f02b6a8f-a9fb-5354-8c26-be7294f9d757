/**
 * 调度核心：纯函数实现，独立于 React Flow，便于测试。
 *
 * 模型约定：
 * - 每条连线 source -> target 表示「target 依赖 source」；
 * - 节点可声明占用的舞台资源（resource，如「追光1」）；
 *   同一资源同一时刻只能服务一个提示，因此同资源上的节点按 nodes
 *   给定的顺序自动串行：序列中靠后的节点隐含依赖前一个节点；
 * - 资源串行约束与显式依赖边共同参与正向 / 反向调度：
 *     最早触发 = max(所有前置约束满足时刻) + delay
 *     最早结束 = 最早触发 + duration
 *     总时长   = max(所有节点最早结束)
 *   再反向传递求最晚时刻，松弛为 0 的节点构成关键路径；
 * - 关键路径上的约束（显式依赖或资源串行）均以关键样式标记。
 */

export interface SchedNodeLike {
  id: string;
  data: {
    duration: number;
    delay: number;
    /** 资源名；空串 / undefined 表示不占用资源 */
    resource?: string;
    /** 仅用于资源队列展示，调度本身不依赖 */
    label?: string;
  };
}

export interface SchedEdgeLike {
  id: string;
  source: string;
  target: string;
}

export interface NodeSchedule {
  earliestStart: number;
  earliestEnd: number;
  latestStart: number;
  latestEnd: number;
  /** 松弛时间（秒）：可以推迟而不影响总时长的余量 */
  slack: number;
  /** 是否在关键路径上 */
  critical: boolean;
  /** 调度生效的资源名（空串表示未占用资源） */
  resource: string;
}

/** 资源队列中的一项排程 */
export interface ResourceQueueItem {
  nodeId: string;
  label: string;
  start: number;
  end: number;
  critical: boolean;
}

export interface ResourceSchedule {
  /** 资源名 */
  name: string;
  /** 该资源上的排程，按串行顺序（开始时刻升序） */
  queue: ResourceQueueItem[];
  /** 该资源最后一项结束的时刻 */
  busyUntil: number;
}

/** 同资源相邻节点之间的自动串行约束（用于画布展示为合成连线） */
export interface ResourceLink {
  /** 合成边 id，与真实边 id 区分 */
  id: string;
  resource: string;
  source: string;
  target: string;
  /** 该串行约束是否位于关键路径上 */
  critical: boolean;
}

export interface ScheduleResult {
  byId: Map<string, NodeSchedule>;
  criticalNodeIds: Set<string>;
  /** 关键的显式依赖边 id */
  criticalEdgeIds: Set<string>;
  /** 全部资源串行约束（含关键标记），供画布绘制合成连线 */
  resourceLinks: ResourceLink[];
  totalDuration: number;
  /** 各资源的串行排程队列 */
  resources: ResourceSchedule[];
  /**
   * 综合约束图（显式依赖 + 资源串行）中存在环。
   * 通常由 UI / 导入校验提前阻止，此处兜底并提示。
   */
  hasCycle: boolean;
}

const EPS = 1e-9;

/** 资源合成连线使用的 id 前缀（与真实边 id 区分） */
export const RESOURCE_EDGE_PREFIX = 'res::';

function nonNeg(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 规整资源名：去首尾空白；空值统一为空串 */
export function normalizeResource(r: unknown): string {
  return typeof r === 'string' ? r.trim() : '';
}

/**
 * 若新增一条 source -> target 的显式依赖边，是否会形成环路。
 * 仅依据显式边判断：在现有图中 target 已可到达 source（或二者相同）。
 */
export function wouldCreateCycle(
  edges: SchedEdgeLike[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  return reaches(adj, target, source);
}

/**
 * 综合约束（显式依赖 + 资源串行）下，新增 source -> target 是否成环。
 * 资源串行按 nodes 顺序构建：同资源第 k 个节点 -> 第 k+1 个节点。
 * 用于连线与导入校验，避免资源顺序与依赖互相矛盾。
 */
export function wouldCreateCycleWithResources<N extends SchedNodeLike>(
  nodes: N[],
  edges: SchedEdgeLike[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of edges) push(e.source, e.target);
  for (const seq of buildResourceConstraints(nodes).ordered.values()) {
    for (let i = 1; i < seq.length; i++) push(seq[i - 1], seq[i]);
  }
  return reaches(adj, target, source);
}

function reaches(adj: Map<string, string[]>, from: string, to: string): boolean {
  const stack = [from];
  const seen = new Set<string>([from]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    for (const nxt of adj.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return false;
}

/**
 * 综合约束图（显式依赖 + 按 nodes 顺序的资源串行）是否存在环。
 * 用于资源名编辑后的即时校验。
 */
export function combinedGraphHasCycle<N extends SchedNodeLike>(
  nodes: N[],
  edges: SchedEdgeLike[],
): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  const all: Array<{ source: string; target: string }> = [];
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) all.push({ source: e.source, target: e.target });
  }
  for (const seq of buildResourceConstraints(nodes).ordered.values()) {
    for (let i = 1; i < seq.length; i++) all.push({ source: seq[i - 1], target: seq[i] });
  }
  return topoOrder(nodes, all).length !== nodes.length;
}

/** Kahn 拓扑排序；若存在环，返回的 order 会短于节点数。 */
function topoOrder(
  nodes: { id: string }[],
  edges: Array<{ source: string; target: string }>,
): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, indeg.get(e.target)! + 1);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const nxt of adj.get(id) ?? []) {
      const d = indeg.get(nxt)! - 1;
      indeg.set(nxt, d);
      if (d === 0) queue.push(nxt);
    }
  }
  return order;
}

interface ResourceConstraint {
  /** 每个资源上的节点 id，按 nodes 顺序（即串行顺序） */
  ordered: Map<string, string[]>;
  /** 节点 -> 同资源队列中的前一节点 */
  pred: Map<string, string>;
  /** 节点 -> 所属资源名 */
  byNode: Map<string, string>;
}

/**
 * 按 nodes 顺序构建资源串行约束：同一资源上第 k 个节点隐含依赖
 * 第 k-1 个节点（资源释放后才能开始）。
 */
function buildResourceConstraints<N extends SchedNodeLike>(nodes: N[]): ResourceConstraint {
  const ordered = new Map<string, string[]>();
  const pred = new Map<string, string>();
  const byNode = new Map<string, string>();
  for (const n of nodes) {
    const res = normalizeResource(n.data.resource);
    if (!res) continue;
    let seq = ordered.get(res);
    if (!seq) {
      seq = [];
      ordered.set(res, seq);
    }
    const prev = seq[seq.length - 1];
    if (prev !== undefined) pred.set(n.id, prev);
    seq.push(n.id);
    byNode.set(n.id, res);
  }
  return { ordered, pred, byNode };
}

/**
 * 计算所有节点的最早/最晚时刻、松弛与关键路径。
 * 资源约束与显式依赖共同参与正向 / 反向传递。
 */
export function computeSchedule<N extends SchedNodeLike>(
  nodes: N[],
  edges: SchedEdgeLike[],
): ScheduleResult {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const validEdges = edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target));

  // 资源串行约束（按 nodes 顺序）
  const rc = buildResourceConstraints(nodes);

  // 显式依赖 + 资源串行约束，合并为统一前驱 / 后继表
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  const allConstraintEdges: Array<{ source: string; target: string }> = [];
  for (const e of validEdges) {
    preds.get(e.target)!.push(e.source);
    succs.get(e.source)!.push(e.target);
    allConstraintEdges.push({ source: e.source, target: e.target });
  }
  for (const [id, prev] of rc.pred) {
    preds.get(id)!.push(prev);
    succs.get(prev)!.push(id);
    allConstraintEdges.push({ source: prev, target: id });
  }

  const order = topoOrder(nodes, allConstraintEdges);
  const hasCycle = order.length !== nodes.length;

  // 正向传递：最早时刻
  const earliestStart = new Map<string, number>();
  const earliestEnd = new Map<string, number>();
  for (const id of order) {
    const n = nodeById.get(id)!;
    let base = 0;
    for (const p of preds.get(id)!) {
      base = Math.max(base, earliestEnd.get(p) ?? 0);
    }
    const start = base + nonNeg(n.data.delay);
    earliestStart.set(id, start);
    earliestEnd.set(id, start + nonNeg(n.data.duration));
  }
  const totalDuration = Math.max(0, ...earliestEnd.values());

  // 反向传递：最晚时刻（资源约束与依赖一起参与）
  const latestStart = new Map<string, number>();
  const latestEnd = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const n = nodeById.get(id)!;
    let le = totalDuration;
    for (const s of succs.get(id)!) {
      const succDelay = nonNeg(nodeById.get(s)!.data.delay);
      le = Math.min(le, (latestStart.get(s) ?? totalDuration) - succDelay);
    }
    latestEnd.set(id, le);
    latestStart.set(id, le - nonNeg(n.data.duration));
  }

  const byId = new Map<string, NodeSchedule>();
  const criticalNodeIds = new Set<string>();
  // 兜底：环中节点不在拓扑序内（正常情况下成环被 UI / 导入阻止），
  // 给一个零值占位，保证资源队列等下游逻辑不崩溃。
  for (const n of nodes) {
    if (nodeById.has(n.id) && !earliestStart.has(n.id)) {
      earliestStart.set(n.id, 0);
      earliestEnd.set(n.id, nonNeg(n.data.duration));
      latestStart.set(n.id, totalDuration);
      latestEnd.set(n.id, totalDuration);
    }
  }
  for (const n of nodes) {
    const id = n.id;
    const es = earliestStart.get(id)!;
    const ee = earliestEnd.get(id)!;
    const ls = latestStart.get(id)!;
    const le = latestEnd.get(id)!;
    const slack = Math.max(0, ls - es);
    const critical = slack < EPS;
    if (critical && !hasCycle) criticalNodeIds.add(id);
    byId.set(id, {
      earliestStart: es,
      earliestEnd: ee,
      latestStart: ls,
      latestEnd: le,
      slack,
      critical: critical && !hasCycle,
      resource: rc.byNode.get(id) ?? '',
    });
  }

  // 判断某条约束（前置 -> 当前）是否被顶满：两端关键且无缓冲
  const isBinding = (prevId: string, id: string): boolean => {
    const a = byId.get(prevId);
    const b = byId.get(id);
    if (!a?.critical || !b?.critical) return false;
    const targetDelay = nonNeg(nodeById.get(id)!.data.delay);
    return Math.abs(a.earliestEnd + targetDelay - b.earliestStart) < EPS;
  };

  // 关键显式依赖边
  const criticalEdgeIds = new Set<string>();
  for (const e of validEdges) {
    if (isBinding(e.source, e.target)) criticalEdgeIds.add(e.id);
  }

  // 资源串行合成连线及其关键标记
  const resourceLinks: ResourceLink[] = [];
  for (const [res, seq] of rc.ordered) {
    for (let i = 1; i < seq.length; i++) {
      const source = seq[i - 1];
      const target = seq[i];
      resourceLinks.push({
        id: `${RESOURCE_EDGE_PREFIX}${res}::${source}::${target}`,
        resource: res,
        source,
        target,
        critical: isBinding(source, target),
      });
    }
  }

  // 资源队列排程
  const resources: ResourceSchedule[] = [];
  for (const [name, seq] of rc.ordered) {
    const queue: ResourceQueueItem[] = seq.map((id) => {
      const s = byId.get(id)!;
      return {
        nodeId: id,
        label: nodeById.get(id)!.data.label ?? id,
        start: s.earliestStart,
        end: s.earliestEnd,
        critical: s.critical,
      };
    });
    queue.sort((a, b) => a.start - b.start || a.end - b.end);
    resources.push({ name, queue, busyUntil: queue[queue.length - 1]?.end ?? 0 });
  }
  resources.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return {
    byId,
    criticalNodeIds,
    criticalEdgeIds,
    resourceLinks,
    totalDuration,
    resources,
    hasCycle,
  };
}

/**
 * 简单分层布局：层 = 距根节点的最长路径（按边数），
 * 同层节点纵向排列。用于「整理布局」与示例数据。
 */
export function layeredLayout(
  nodes: { id: string }[],
  edges: SchedEdgeLike[],
  opts: { xGap?: number; yGap?: number; x0?: number; y0?: number } = {},
): Map<string, { x: number; y: number }> {
  const { xGap = 280, yGap = 120, x0 = 60, y0 = 60 } = opts;
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    preds.get(e.target)!.push(e.source);
    succs.get(e.source)!.push(e.target);
  }

  const order = topoOrder(nodes, edges);
  const layer = new Map<string, number>();
  for (const id of order) {
    let l = 0;
    for (const p of preds.get(id)!) {
      l = Math.max(l, (layer.get(p) ?? 0) + 1);
    }
    layer.set(id, l);
  }
  // 兜底：环中节点（正常不会发生）放到第 0 层
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0);

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id)!;
    const arr = byLayer.get(l) ?? [];
    arr.push(n.id);
    byLayer.set(l, arr);
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, layerIds] of byLayer) {
    layerIds.forEach((id, i) => {
      pos.set(id, { x: x0 + l * xGap, y: y0 + i * yGap });
    });
  }
  return pos;
}
