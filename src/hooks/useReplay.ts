import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampLoopRegion,
  firedBefore,
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
  /** 产生该提示时的循环轮次（未启用循环时恒为 1） */
  iteration: number;
}

/** 当前循环区间与启用状态 */
export interface LoopState extends LoopRegion {
  /** 停用后保留区间，再次启用即可恢复循环 */
  enabled: boolean;
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
  /** 已触发提示的节点 id（本轮内不重复触发） */
  firedIds: Set<string>;
  /** 循环区间（含启用状态），未设置时为 null */
  loop: LoopState | null;
  /** 当前循环轮次（从 1 开始，每次回退到入点 +1） */
  loopIteration: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** 重置回放：时钟回到 T+0、清空提示与触发记录、轮次归 1（保留循环区间） */
  reset: () => void;
  /** 拖动时间轴（或点击）跳转到指定时刻，并整体重算节点状态 */
  seek: (t: number) => void;
  clearAlerts: () => void;
  /** 以 t 为循环入点（自动启用循环）；区间不合法时返回 false */
  setLoopIn: (t: number) => boolean;
  /** 以 t 为循环出点（自动启用循环）；区间不合法时返回 false */
  setLoopOut: (t: number) => boolean;
  /** 直接设置循环区间（自动规范顺序并启用）；区间不合法时返回 false */
  setLoopRegion: (start: number, end: number) => boolean;
  /** 启用 / 停用循环（停用保留区间） */
  toggleLoop: () => void;
  /** 清除循环区间 */
  clearLoop: () => void;
}

const EPS = 1e-6;
/** 单帧最长推进秒数：切换到后台标签页再回来时避免时钟瞬间跳完 */
const MAX_STEP = 0.25;
/** 提示记录最多保留条数 */
const MAX_ALERTS = 40;
/** 单次推进允许的最大循环回退次数（区间过小时的保险丝） */
const MAX_WRAPS_PER_ADVANCE = 100;

/**
 * 排练回放控制器。
 *
 * - 播放时以 requestAnimationFrame 驱动演出时钟，时钟越过某节点最早触发
 *   时刻即产生一条「到点提示」，资源串行等待与显式依赖都已体现在
 *   调度器给出的触发时刻上，回放直接沿用；
 * - 暂停 / 继续只是停止 / 恢复推进，节点状态由当前时钟整体重算；
 * - 拖动跳转：将所有触发时刻严格早于目标时刻的节点标记为已触发，
 *   继续播放时不会重复弹提示（精确落在目标时刻上的节点仍会正常触发）；
 * - 循环区间：启用后时钟越过出点自动回退到入点并进入下一轮。回退时
 *   仅区间内（入点 <= 触发时刻 < 出点）的提示重新武装——每轮重新触发、
 *   同一轮不重复；区间外已完成的提示仍保持已触发，不会重复弹出；
 * - 编辑（节点 / 连线 / 资源）导致时间轴或总时长变化时做对账：
 *   时钟已经越过的触发点补登记，时钟未到的节点解除登记，并校正
 *   越界的循环区间（区间失效则清除）。
 */
export function useReplay({ timeline, totalDuration }: UseReplayOptions): UseReplay {
  const [time, setTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [alerts, setAlerts] = useState<CueAlert[]>([]);
  const [firedVersion, setFiredVersion] = useState(0);
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [loopIteration, setLoopIteration] = useState(1);

  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const firedRef = useRef<Set<string>>(new Set());
  const alertSeqRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);
  const lastWallRef = useRef<number | null>(null);
  const loopRef = useRef<LoopState | null>(null);
  const iterationRef = useRef(1);

  const timelineRef = useRef(timeline);
  const totalRef = useRef(totalDuration);
  timelineRef.current = timeline;
  totalRef.current = totalDuration;

  const bumpFired = useCallback(() => setFiredVersion((v) => v + 1), []);

  /** 应用新的循环区间（或清除）：同步 ref 与 state，并把轮次归 1 */
  const applyLoop = useCallback((next: LoopState | null) => {
    loopRef.current = next;
    setLoop(next);
    iterationRef.current = 1;
    setLoopIteration(1);
  }, []);

  const emitAlerts = useCallback((entries: TimelineEntry[]) => {
    if (entries.length === 0) return;
    const iteration = iterationRef.current;
    setAlerts((prev) => {
      const next = entries.map((e) => {
        alertSeqRef.current += 1;
        return {
          id: alertSeqRef.current,
          nodeId: e.nodeId,
          label: e.label,
          cueType: e.cueType,
          at: e.start,
          iteration,
        };
      });
      // 新触发的提示排到最前，最多保留 MAX_ALERTS 条
      return [...next.reverse(), ...prev].slice(0, MAX_ALERTS);
    });
  }, []);

  /** 触发区间 (from, to] 内尚未触发的节点（含端点容差），并登记为已触发 */
  const fireBetween = useCallback(
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

  /**
   * 时钟从 from 推进到 to。
   * 启用循环且推进越过出点时：先触发到出点，回退到入点进入下一轮
   * （区间内提示重新武装，区间外已完成提示保持不重复），
   * 再从入点继续推进剩余路程；一次推进跨过多个循环时逐轮回退。
   */
  const advance = useCallback(
    (from: number, to: number) => {
      const total = Math.max(0, totalRef.current);
      let target = total > 0 ? Math.min(to, total) : to;
      let cursor = from;
      let wrapped = false;
      const active = loopRef.current;
      if (active && active.enabled && active.end > active.start + EPS) {
        let guard = 0;
        while (
          target > active.end - EPS &&
          cursor < active.end - EPS &&
          guard < MAX_WRAPS_PER_ADVANCE
        ) {
          // 先走完本轮剩余路程（触发到出点为止）
          fireBetween(cursor, active.end);
          // 回退到入点：仅区间内的提示重新武装，区间外已完成提示仍不可重复
          for (const e of timelineRef.current) {
            if (e.start >= active.start - EPS && e.start < active.end - EPS) {
              firedRef.current.delete(e.nodeId);
            }
          }
          bumpFired();
          iterationRef.current += 1;
          setLoopIteration(iterationRef.current);
          wrapped = true;
          const remaining = target - active.end;
          cursor = active.start;
          target = active.start + remaining;
          guard += 1;
        }
      }
      if (target > cursor + EPS || (wrapped && target > cursor - EPS)) {
        fireBetween(cursor, target);
      }
      timeRef.current = target;
      setTime(target);
      if (total > 0 && target >= total - EPS) {
        playingRef.current = false;
        setIsPlaying(false);
      }
    },
    [bumpFired, fireBetween],
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
    // 已到结尾再按播放：从头开始（重置后启动）
    if (timeRef.current >= total - EPS) {
      timeRef.current = 0;
      setTime(0);
      firedRef.current = new Set();
      bumpFired();
      setAlerts([]);
      iterationRef.current = 1;
      setLoopIteration(1);
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
      // 时钟越过的触发点一律补登记：跳转后不得重复触发已完成节点
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
    bumpFired();
    setAlerts([]);
    iterationRef.current = 1;
    setLoopIteration(1);
  }, [bumpFired]);

  const clearAlerts = useCallback(() => setAlerts([]), []);

  // ---- 循环区间 ----
  const setLoopIn = useCallback(
    (t: number) => {
      const total = Math.max(0, totalRef.current);
      if (total <= 0) return false;
      const start = Math.min(Math.max(0, t), total);
      const end = loopRef.current ? loopRef.current.end : total;
      const next = clampLoopRegion({ start, end }, total);
      if (!next) return false;
      applyLoop({ ...next, enabled: true });
      return true;
    },
    [applyLoop],
  );

  const setLoopOut = useCallback(
    (t: number) => {
      const total = Math.max(0, totalRef.current);
      if (total <= 0) return false;
      const end = Math.min(Math.max(0, t), total);
      const start = loopRef.current ? loopRef.current.start : 0;
      const next = clampLoopRegion({ start, end }, total);
      if (!next) return false;
      applyLoop({ ...next, enabled: true });
      return true;
    },
    [applyLoop],
  );

  const setLoopRegion = useCallback(
    (a: number, b: number) => {
      const total = Math.max(0, totalRef.current);
      if (total <= 0) return false;
      const next = clampLoopRegion({ start: Math.min(a, b), end: Math.max(a, b) }, total);
      if (!next) return false;
      applyLoop({ ...next, enabled: true });
      return true;
    },
    [applyLoop],
  );

  const toggleLoop = useCallback(() => {
    const prev = loopRef.current;
    if (!prev) return;
    const next = { ...prev, enabled: !prev.enabled };
    loopRef.current = next;
    setLoop(next);
  }, []);

  const clearLoop = useCallback(() => {
    applyLoop(null);
  }, [applyLoop]);

  // 编辑（增删节点 / 改时长 / 改依赖与资源）导致时间轴变化后的对账：
  // 当前时钟已经越过的触发点补登记，时钟未到的节点解除登记，
  // 使「已完成节点不重复触发」在任何跳转与编辑之后都成立；
  // 同时校正随总时长变化而越界的循环区间（区间失效则清除）。
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
    // 循环区间越界校正：夹回 [0, total]，失效（长度不足 / 总时长为 0）则清除
    const active = loopRef.current;
    if (active) {
      const clamped = clampLoopRegion(active, total);
      if (!clamped) {
        applyLoop(null);
      } else if (
        Math.abs(clamped.start - active.start) > EPS ||
        Math.abs(clamped.end - active.end) > EPS
      ) {
        const next = { ...active, ...clamped };
        loopRef.current = next;
        setLoop(next);
      }
    }
  }, [timeline, totalDuration, bumpFired, applyLoop]);

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
    loopIteration,
    play,
    pause,
    toggle,
    reset,
    seek,
    clearAlerts,
    setLoopIn,
    setLoopOut,
    setLoopRegion,
    toggleLoop,
    clearLoop,
  };
}
