import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  firedBefore,
  isValidLoopRegion,
  loopFiredIds,
  normalizeLoopRegion,
  snapshotAt,
  type LoopRegion,
  type ReplaySnapshot,
  type TimelineEntry,
} from '../lib/replay';
import type { CueType } from '../types';

/** 一条「到点提示」记录（时钟越过节点触发时刻时产生） */
export interface CueAlert {
  id: number;
  nodeId: string;
  label: string;
  cueType: CueType;
  /** 应触发的演出时钟时刻（秒） */
  at: number;
  /** 触发时所处的循环轮次（首轮为 1） */
  round: number;
}

export interface UseReplayOptions {
  timeline: TimelineEntry[];
  /** 调度总时长（秒），时间轴终点 */
  totalDuration: number;
}

export interface UseReplay {
  /** 当前演出时钟（秒，T+0 = 演出开始） */
  time: number;
  isPlaying: boolean;
  /** 复位后从未启动时为 idle，便于 UI 区分 */
  playbackState: 'idle' | 'playing' | 'paused';
  /** 当前时刻全量节点状态（暂停 / 继续 / 跳转后整体重算） */
  snapshot: ReplaySnapshot;
  /** 已产生的到点提示，最新在前 */
  alerts: CueAlert[];
  /** 已触发提示的节点 id（跳转后不会重复触发；循环回退时区间内登记会解除） */
  firedIds: Set<string>;
  /** 当前循环区间（启用后）；null 表示未循环 */
  loop: LoopRegion | null;
  /** 当前循环轮次：首轮为 1，每回退一次 +1；关闭循环 / 重置回到 1 */
  round: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** 重置回放：时钟回到 T+0、清空提示与触发记录（保留循环区间设置） */
  reset: () => void;
  /** 拖动时间轴（或点击）跳转到指定时刻，并整体重算节点状态；跳转本身不回退、不跳轮次 */
  seek: (t: number) => void;
  clearAlerts: () => void;
  /** 在当前时钟设置循环入点 / 出点（设置后自动规范化、自动启用循环） */
  setLoopIn: () => void;
  setLoopOut: () => void;
  /** 启用 / 关闭循环：未设置区间时启用表示整场循环 */
  toggleLoop: () => void;
  /** 清除循环区间并关闭循环（播放进度与触发记录不变） */
  clearLoop: () => void;
}

const EPS = 1e-6;
/** 单帧最长推进秒数：切换到后台标签页再回来时避免时钟瞬间跳完 */
const MAX_STEP = 0.25;
/** 提示记录最多保留条数 */
const MAX_ALERTS = 40;

/**
 * 排练回放控制器。
 *
 * - 播放时以 requestAnimationFrame 驱动演出时钟，时钟越过某节点最早触发
 *   时刻即产生一条「到点提示」，资源串行等待与显式依赖都已体现在
 *   调度器给出的触发时刻上，回放直接沿用；
 * - 暂停 / 继续只是停止 / 恢复推进，节点状态由当前时钟整体重算；
 * - 拖动跳转：将所有触发时刻严格早于目标时刻的节点标记为已触发，
 *   继续播放时不会重复弹提示（精确落在目标时刻上的节点仍会正常触发）；
 * - 编辑（节点 / 连线 / 资源）导致时间轴变化时，对已触发集合做对账：
 *   时钟已经越过的触发点补登记，时钟未到的节点解除登记；
 * - 可编辑循环区间：播放到出点自动回到入点并进入下一轮，区间内节点
 *   解除已触发登记，每轮重新提示且同一轮不重复；区间外节点登记保留；
 * - 循环区间随总时长变化自动夹取校正，越界（含导入节点）后仍保持有效。
 */
export function useReplay({ timeline, totalDuration }: UseReplayOptions): UseReplay {
  const [time, setTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [alerts, setAlerts] = useState<CueAlert[]>([]);
  const [firedVersion, setFiredVersion] = useState(0);
  const [loop, setLoop] = useState<LoopRegion | null>(null);
  const [round, setRound] = useState(1);

  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const firedRef = useRef<Set<string>>(new Set());
  const alertSeqRef = useRef(0);
  const roundRef = useRef(1);
  const rafRef = useRef<number | undefined>(undefined);
  const lastWallRef = useRef<number | null>(null);

  const timelineRef = useRef(timeline);
  const totalRef = useRef(totalDuration);
  const loopRef = useRef<LoopRegion | null>(null);
  timelineRef.current = timeline;
  totalRef.current = totalDuration;
  loopRef.current = loop;

  const bumpFired = useCallback(() => setFiredVersion((v) => v + 1), []);

  const emitAlerts = useCallback((entries: TimelineEntry[]) => {
    if (entries.length === 0) return;
    setAlerts((prev) => {
      const next = entries.map((e) => {
        alertSeqRef.current += 1;
        return {
          id: alertSeqRef.current,
          nodeId: e.nodeId,
          label: e.label,
          cueType: e.cueType,
          at: e.start,
          round: roundRef.current,
        };
      });
      // 新触发的提示排到最前，最多保留 MAX_ALERTS 条
      return [...next.reverse(), ...prev].slice(0, MAX_ALERTS);
    });
  }, []);

  /** 收集 (from, to] 内尚未触发的节点：登记并弹出到点提示 */
  const fireDue = useCallback(
    (from: number, to: number) => {
      const due = timelineRef.current.filter(
        (e) =>
          e.start > from - EPS &&
          e.start <= to + EPS &&
          !firedRef.current.has(e.nodeId),
      );
      if (due.length > 0) {
        due.forEach((e) => firedRef.current.add(e.nodeId));
        bumpFired();
        emitAlerts(due);
      }
    },
    [bumpFired, emitAlerts],
  );

  /** 时钟从 from 推进到 to：触发提示；启用循环时到达出点即回退并进入下一轮 */
  const advance = useCallback(
    (from: number, to: number) => {
      const total = Math.max(0, totalRef.current);
      const clampedTo = total > 0 ? Math.min(to, total) : to;
      const activeLoop = isValidLoopRegion(loopRef.current) ? loopRef.current : null;

      if (clampedTo > from + EPS) {
        if (activeLoop && clampedTo >= activeLoop.outPoint - EPS) {
          // 到达出点：先结算本轮 (from, outPoint] 的提示，再回退。
          // from 已在出点之外（如播放中区间被缩短）时直接回退、不补发。
          if (from < activeLoop.outPoint + EPS) {
            fireDue(from, activeLoop.outPoint);
          }
          for (const id of loopFiredIds(timelineRef.current, activeLoop)) {
            firedRef.current.delete(id);
          }
          roundRef.current += 1;
          setRound(roundRef.current);
          bumpFired();
          // 回退到入点；超出出点的帧时间不结转，保证轮次边界清晰
          timeRef.current = activeLoop.inPoint;
          setTime(activeLoop.inPoint);
          return;
        }
        fireDue(from, clampedTo);
      }
      timeRef.current = clampedTo;
      setTime(clampedTo);
      if (!activeLoop && total > 0 && clampedTo >= total - EPS) {
        playingRef.current = false;
        setIsPlaying(false);
      }
    },
    [bumpFired, fireDue],
  );

  // rAF 演出时钟
  useEffect(() => {
    const tick = (wall: number) => {
      rafRef.current = window.requestAnimationFrame(tick);
      if (!playingRef.current) {
        lastWallRef.current = wall;
        return;
      }
      const prevWall = lastWallRef.current;
      lastWallRef.current = wall;
      if (prevWall === null) return;
      const dt = Math.min(MAX_STEP, Math.max(0, (wall - prevWall) / 1000));
      if (dt > 0) advance(timeRef.current, timeRef.current + dt);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
      lastWallRef.current = null;
    };
  }, [advance]);

  const play = useCallback(() => {
    const total = Math.max(0, totalRef.current);
    if (total <= 0) return;
    const activeLoop = isValidLoopRegion(loopRef.current) ? loopRef.current : null;
    // 已到结尾再按播放：从头开始（重置后启动）；循环区间设置保留，轮次重新计 1
    if (timeRef.current >= total - EPS) {
      if (activeLoop) {
        // 启用循环且已到结尾（含出点即结尾）：进入循环下一轮，区间外已完成提示仍保留
        for (const id of loopFiredIds(timelineRef.current, activeLoop)) {
          firedRef.current.delete(id);
        }
        timeRef.current = activeLoop.inPoint;
        setTime(activeLoop.inPoint);
      } else {
        timeRef.current = 0;
        setTime(0);
        firedRef.current = new Set();
      }
      roundRef.current = 1;
      setRound(1);
      bumpFired();
      setAlerts([]);
    } else if (activeLoop && timeRef.current >= activeLoop.outPoint - EPS) {
      // 当前时钟已在出点之外（如先跳转到区间外再按播放）：直接进入下一轮
      for (const id of loopFiredIds(timelineRef.current, activeLoop)) {
        firedRef.current.delete(id);
      }
      roundRef.current += 1;
      setRound(roundRef.current);
      bumpFired();
      timeRef.current = activeLoop.inPoint;
      setTime(activeLoop.inPoint);
    }
    lastWallRef.current = null;
    playingRef.current = true;
    setIsPlaying(true);
  }, [bumpFired]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  const seek = useCallback(
    (t: number) => {
      const total = Math.max(0, totalRef.current);
      const target = total > 0 ? Math.min(total, Math.max(0, t)) : 0;
      // 时钟越过的触发点一律补登记：跳转后不得重复触发已完成节点。
      // 跳转只移动时钟，既不执行循环回退，也不改变循环轮次。
      for (const id of firedBefore(timelineRef.current, target)) {
        firedRef.current.add(id);
      }
      bumpFired();
      timeRef.current = target;
      setTime(target);
    },
    [bumpFired],
  );

  const reset = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
    timeRef.current = 0;
    setTime(0);
    firedRef.current = new Set();
    roundRef.current = 1;
    setRound(1);
    bumpFired();
    setAlerts([]);
    // 循环区间（入点 / 出点与启用状态）保留：重置只回放进度，不丢弃用户设置
  }, [bumpFired]);

  const clearAlerts = useCallback(() => setAlerts([]), []);

  /** 更新循环区间并同步轮次：区间失效（清除 / 越界退化）时回到首轮 */
  const applyLoop = useCallback((next: LoopRegion | null) => {
    loopRef.current = next;
    setLoop(next);
    if (!next) {
      roundRef.current = 1;
      setRound(1);
    }
  }, []);

  const setLoopIn = useCallback(() => {
    const total = Math.max(0, totalRef.current);
    if (total <= 0) return;
    applyLoop(
      normalizeLoopRegion(
        { inPoint: timeRef.current, outPoint: loopRef.current?.outPoint ?? total },
        total,
      ),
    );
  }, [applyLoop]);

  const setLoopOut = useCallback(() => {
    const total = Math.max(0, totalRef.current);
    if (total <= 0) return;
    applyLoop(
      normalizeLoopRegion(
        { inPoint: loopRef.current?.inPoint ?? 0, outPoint: timeRef.current },
        total,
      ),
    );
  }, [applyLoop]);

  const toggleLoop = useCallback(() => {
    const total = Math.max(0, totalRef.current);
    if (total <= 0) return;
    if (loopRef.current) {
      applyLoop(null);
    } else {
      // 未设置区间时启用 = 整场循环
      applyLoop(normalizeLoopRegion({ inPoint: 0, outPoint: total }, total));
    }
  }, [applyLoop]);

  const clearLoop = useCallback(() => {
    applyLoop(null);
  }, [applyLoop]);

  // 编辑（增删节点 / 改时长 / 改依赖与资源）导致时间轴变化后的对账：
  // 当前时钟已经越过的触发点补登记，时钟未到的节点解除登记，
  // 使「已完成节点不重复触发」在任何跳转与编辑之后都成立。
  useEffect(() => {
    const passed = new Set(firedBefore(timeline, timeRef.current));
    let changed = false;
    for (const e of timeline) {
      if (passed.has(e.nodeId)) {
        if (!firedRef.current.has(e.nodeId)) {
          firedRef.current.add(e.nodeId);
          changed = true;
        }
      } else if (firedRef.current.has(e.nodeId)) {
        firedRef.current.delete(e.nodeId);
        changed = true;
      }
    }
    for (const id of firedRef.current) {
      if (!timeline.some((e) => e.nodeId === id)) {
        firedRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) bumpFired();
    const total = Math.max(0, totalDuration);
    if (total > 0 && timeRef.current > total + EPS) {
      timeRef.current = total;
      setTime(total);
    }
  }, [timeline, totalDuration, bumpFired]);

  // 总时长变化（编辑节点 / 导入 JSON）后校正越界的循环区间：
  // 边界夹取到新总时长，区间退化（in == out）则自动关闭循环。
  useEffect(() => {
    if (!loop) return;
    const next = normalizeLoopRegion(loop, totalDuration);
    if (
      !next ||
      Math.abs(next.inPoint - loop.inPoint) > EPS ||
      Math.abs(next.outPoint - loop.outPoint) > EPS
    ) {
      applyLoop(next);
    }
  }, [loop, totalDuration, applyLoop]);

  const snapshot = useMemo(() => snapshotAt(timeline, time), [timeline, time]);

  const playbackState: UseReplay['playbackState'] =
    isPlaying ? 'playing' : time > EPS || firedRef.current.size > 0 || alerts.length > 0 ? 'paused' : 'idle';

  return {
    time,
    isPlaying,
    playbackState,
    snapshot,
    alerts,
    // firedVersion 参与依赖，保证已触发集合变化时返回值同步
    firedIds: useMemo(() => firedRef.current, [firedVersion]),
    loop,
    round,
    play,
    pause,
    toggle,
    reset,
    seek,
    clearAlerts,
    setLoopIn,
    setLoopOut,
    toggleLoop,
    clearLoop,
  };
}
