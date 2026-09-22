/**
 * 排练回放核心：纯函数实现，独立于 React，便于复用与测试。
 *
 * 时间轴直接沿用调度结果（computeSchedule）：
 * - earliestStart / earliestEnd 已经包含显式依赖边与资源串行等待
 *   （同资源按节点顺序排队、互不重叠）的全部约束，回放无需重复建模；
 * - 演出时钟从 T+0 开始，节点状态仅由「当前时刻」推导：
 *     待触发 waiting ：t < earliestStart
 *     进行中 running ：earliestStart <= t < earliestEnd
 *     已完成 done   ：t >= earliestEnd
 *   持续时间为 0 的提示在触发时刻即已完成（不存在进行中区间）。
 *
 * 因为状态是当前时刻的纯函数，暂停 / 继续 / 拖动跳转后只需重算快照，
 * 已完成节点天然不会被再次置为进行中；是否再次产生「到点提示」
 * 则由 useReplay 中的已触发集合单独控制。
 */
import type { ScheduleResult } from './schedule';
import type { CueType, ReplayStatus } from '../types';

const EPS = 1e-6;

/** 时间轴上的一项：节点在演出时钟上的触发 / 结束区间 */
export interface TimelineEntry {
  nodeId: string;
  label: string;
  cueType: CueType;
  /** 最早触发时刻（秒，T+0 为演出开始），已含依赖与资源串行等待 */
  start: number;
  /** 最早结束时刻（秒） */
  end: number;
}

/** 某一时刻全量节点状态快照 */
export interface ReplaySnapshot {
  statusById: Map<string, ReplayStatus>;
  /** 按时间轴顺序（触发时刻升序） */
  waitingIds: string[];
  runningIds: string[];
  doneIds: string[];
}

/**
 * 依据当前调度结果建立回放时间轴。
 * 按触发时刻升序；时刻相同时保持节点在画布中的顺序（与资源排队顺序一致）。
 */
export function buildTimeline(
  nodes: Array<{ id: string; data: { label: string; cueType: CueType } }>,
  schedule: ScheduleResult,
): TimelineEntry[] {
  return nodes
    .map((n, order) => {
      const s = schedule.byId.get(n.id);
      return {
        nodeId: n.id,
        label: n.data.label,
        cueType: n.data.cueType,
        start: s?.earliestStart ?? 0,
        end: s?.earliestEnd ?? 0,
        order,
      };
    })
    .sort((a, b) => a.start - b.start || a.order - b.order)
    .map(({ nodeId, label, cueType, start, end }): TimelineEntry => ({
      nodeId,
      label,
      cueType,
      start,
      end,
    }));
}

/** 单个节点在演出时钟 t 时刻的状态（纯函数） */
export function statusAt(entry: TimelineEntry, t: number): ReplayStatus {
  if (t >= entry.end - EPS) return 'done';
  if (t + EPS >= entry.start) return 'running';
  return 'waiting';
}

/** 计算 t 时刻全量节点状态快照（暂停 / 继续 / 跳转后调用即可重算） */
export function snapshotAt(timeline: TimelineEntry[], t: number): ReplaySnapshot {
  const statusById = new Map<string, ReplayStatus>();
  const waitingIds: string[] = [];
  const runningIds: string[] = [];
  const doneIds: string[] = [];
  for (const e of timeline) {
    const st = statusAt(e, t);
    statusById.set(e.nodeId, st);
    if (st === 'waiting') waitingIds.push(e.nodeId);
    else if (st === 'running') runningIds.push(e.nodeId);
    else doneIds.push(e.nodeId);
  }
  return { statusById, waitingIds, runningIds, doneIds };
}

/**
 * 跳转到 t 时刻时，应被视为「已经触发过」的节点 id：
 * 即触发时刻已严格位于当前时钟之前的节点。
 * 精确落在 t 上的节点不包含在内（此刻才是它的触发点）。
 */
export function firedBefore(timeline: TimelineEntry[], t: number): string[] {
  const ids: string[] = [];
  for (const e of timeline) {
    if (e.start < t - EPS) ids.push(e.nodeId);
  }
  return ids;
}

/** 将秒数格式化为演出时钟：M:SS.s（超过 1 小时为 H:MM:SS.s） */
export function formatClock(t: number): string {
  const total = Math.max(0, Number.isFinite(t) ? t : 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total - hours * 3600) / 60);
  const seconds = total - hours * 3600 - minutes * 60;
  const ss = seconds.toFixed(1).padStart(4, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
    : `${minutes}:${ss}`;
}
