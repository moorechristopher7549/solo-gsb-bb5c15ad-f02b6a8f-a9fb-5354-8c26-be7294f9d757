/**
 * JSON 导入 / 导出：文件格式 v1。
 *
 * {
 *   "version": 1,
 *   "exportedAt": "...",        // 可选
 *   "nodes": [{
 *     "id", "type", "label", "duration", "delay",
 *     "resource": "追光1",       // 可选；缺省 / 空串 = 不占用资源
 *     "position": {x, y}
 *   }],
 *   "edges": [{ "id", "source", "target" }]
 * }
 */
import { CUE_TYPES, type CueType } from '../types';
import { normalizeResource, wouldCreateCycleWithResources } from './schedule';

export const SHOW_FILE_VERSION = 1;

export interface ImportedNode {
  id: string;
  cueType: CueType;
  label: string;
  duration: number;
  delay: number;
  resource: string;
  position: { x: number; y: number };
}

export interface ImportedEdge {
  id: string;
  source: string;
  target: string;
}

export function serializeShow(
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    data: {
      label: string;
      cueType: CueType;
      duration: number;
      delay: number;
      resource?: string;
    };
  }>,
  edges: Array<{ id: string; source: string; target: string }>,
): string {
  const file = {
    version: SHOW_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.cueType,
      label: n.data.label,
      duration: n.data.duration,
      delay: n.data.delay,
      resource: normalizeResource(n.data.resource),
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
  return JSON.stringify(file, null, 2);
}

export type ParseResult =
  | { ok: true; nodes: ImportedNode[]; edges: ImportedEdge[] }
  | { ok: false; error: string };

function fail(error: string): ParseResult {
  return { ok: false, error };
}

export function parseShow(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('文件不是有效的 JSON');
  }
  if (typeof raw !== 'object' || raw === null) return fail('JSON 顶层必须是对象');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    return fail('缺少 nodes / edges 数组');
  }

  const ids = new Set<string>();
  const nodes: ImportedNode[] = [];
  for (const [i, item] of (obj.nodes as unknown[]).entries()) {
    const where = `第 ${i + 1} 个节点`;
    if (typeof item !== 'object' || item === null) return fail(`${where}格式无效`);
    const n = item as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id.trim() === '') return fail(`${where}缺少有效 id`);
    if (ids.has(n.id)) return fail(`节点 id 重复：${n.id}`);
    ids.add(n.id);
    if (!CUE_TYPES.includes(n.type as CueType)) {
      return fail(`${where}（${n.id}）类型无效，应为 lighting / sound / actor`);
    }
    const duration = Number(n.duration);
    const delay = Number(n.delay ?? 0);
    if (!Number.isFinite(duration) || duration < 0) return fail(`${where}（${n.id}）持续时间无效`);
    if (!Number.isFinite(delay) || delay < 0) return fail(`${where}（${n.id}）延迟无效`);
    // resource 缺省（旧版文件 / 未填写）一律视为不占用资源
    const resource = normalizeResource(n.resource);
    const pos = (typeof n.position === 'object' && n.position !== null ? n.position : {}) as Record<string, unknown>;
    const px = Number(pos.x);
    const py = Number(pos.y);
    nodes.push({
      id: n.id,
      cueType: n.type as CueType,
      label: typeof n.label === 'string' && n.label.trim() !== '' ? n.label : n.id,
      duration,
      delay,
      resource,
      position: {
        x: Number.isFinite(px) ? px : 80 + (i % 4) * 280,
        y: Number.isFinite(py) ? py : 80 + Math.floor(i / 4) * 120,
      },
    });
  }

  const edgeIds = new Set<string>();
  const edges: ImportedEdge[] = [];
  for (const [i, item] of (obj.edges as unknown[]).entries()) {
    const where = `第 ${i + 1} 条连线`;
    if (typeof item !== 'object' || item === null) return fail(`${where}格式无效`);
    const e = item as Record<string, unknown>;
    if (typeof e.source !== 'string' || typeof e.target !== 'string') {
      return fail(`${where}缺少 source / target`);
    }
    if (!ids.has(e.source) || !ids.has(e.target)) {
      return fail(`${where}（${e.source} → ${e.target}）引用了不存在的节点`);
    }
    // 逐条校验：显式依赖与「按节点顺序的资源串行」共同构成的约束图必须无环
    const schedNodes = nodes.map((n) => ({
      id: n.id,
      data: { duration: n.duration, delay: n.delay, resource: n.resource, label: n.label },
    }));
    if (wouldCreateCycleWithResources(schedNodes, edges, e.source, e.target)) {
      return fail(
        `连线 ${e.source} → ${e.target} 会与依赖 / 资源串行顺序形成环路，已拒绝导入`,
      );
    }
    const id = typeof e.id === 'string' && e.id !== '' ? e.id : `e-${e.source}-${e.target}-${i}`;
    if (edgeIds.has(id)) return fail(`连线 id 重复：${id}`);
    edgeIds.add(id);
    edges.push({ id, source: e.source, target: e.target });
  }

  return { ok: true, nodes, edges };
}
