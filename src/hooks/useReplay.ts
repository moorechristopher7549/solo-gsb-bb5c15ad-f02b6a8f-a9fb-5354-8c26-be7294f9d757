import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  firedBefore,
  snapshotAt,
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
  /** 已触发提示的节点 id（跳转后不会重复触发） */
  firedIds: Set<string>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** 重置回放：时钟回到 T+0、清空提示与触发记录 */
  reset: () => void;
  /** 拖动时间轴（或点击）跳转到指定时刻，并整体重算节点状态 */
  seek: (t: number) => void;
  clearAlerts: () => void;
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
 *   时钟已经越过的触发点补登记，时钟未到的节点解除登记。
 */
export function useReplay({ timeline, totalDuration }: UseReplayOptions): UseReplay {
  const [time, setTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [alerts, setAlerts] = useState<CueAlert[]>([]);
  const [firedVersion, setFiredVersion] = useState(0);

  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const firedRef = useRef<Set<string>>(new Set());
  const alertSeqRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);
  const lastWallRef = useRef<number | null>(null);

  const timelineRef = useRef(timeline);
  const totalRef = useRef(totalDuration);
  timelineRef.current = timeline;
  totalRef.current = totalDuration;

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
        };
      });
      // 新触发的提示排到最前，最多保留 MAX_ALERTS 条
      return [...next.reverse(), ...prev].slice(0, MAX_ALERTS);
    });
  }, []);

  /** 时钟从 from 推进到 to 时，收集区间 (from, to] 内尚未触发的节点 */
  const advance = useCallback(
    (from: number, to: number) => {
      const total = Math.max(0, totalRef.current);
      const clampedTo = total > 0 ? Math.min(to, total) : to;
      if (clampedTo > from + EPS) {
        const due = timelineRef.current.filter(
          (e) =>
            e.start > from - EPS &&
            e.start <= clampedTo + EPS &&
            !firedRef.current.has(e.nodeId),
        );
        if (due.length > 0) {
          due.forEach((e) => firedRef.current.add(e.nodeId));
          bumpFired();
          emitAlerts(due);
        }
      }
      timeRef.current = clampedTo;
      setTime(clampedTo);
      if (total > 0 && clampedTo >= total - EPS) {
        playingRef.current = false;
        setIsPlaying(false);
      }
    },
    [bumpFired, emitAlerts],
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
  }, [bumpFired]);

  const clearAlerts = useCallback(() => setAlerts([]), []);

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
    play,
    pause,
    toggle,
    reset,
    seek,
    clearAlerts,
  };
}
