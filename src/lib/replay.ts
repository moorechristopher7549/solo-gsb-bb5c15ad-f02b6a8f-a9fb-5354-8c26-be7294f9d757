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
 *
 * 循环区间（LoopRegion）：入点 / 出点均为演出时钟秒数。启用循环后，
 * 时钟越过出点即回退到入点进入下一轮；回退时仅「区间内」的提示
 * （入点 <= 触发时刻 < 出点）重新武装、按轮重新触发，区间外已完成
 * 提示仍不可重复。总时长变化时用 clampLoopRegion 校正越界区间。
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

/** 循环区间（秒）：播放到出点后自动回到入点继续 */
export interface LoopRegion {
  /** 入点（秒，含）：区间下界，触发时刻 >= 入点的提示属于区间内 */
  start: number;
  /** 出点（秒，不含）：时钟越过该时刻即回退到入点 */
  end: number;
}

/** 循环区间最小长度（秒）：避免零长 / 过短区间导致回退空转 */
export const MIN_LOOP_LENGTH = 0.1;

/**
 * 将循环区间夹取到 [0, total]（导入或编辑节点导致总时长变化后调用）：
 * 越界的入点 / 出点被拉回范围内；夹取后区间长度不足最小长度
 * （或总时长为 0）时返回 null，表示区间已失效应被清除。
 */
export function clampLoopRegion(region: LoopRegion, total: number): LoopRegion | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const start = Math.min(Math.max(0, region.start), total);
  const end = Math.min(Math.max(0, region.end), total);
  if (end - start < MIN_LOOP_LENGTH - EPS) return null;
  return { start, end };
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
