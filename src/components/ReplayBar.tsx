import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { formatClock, MIN_LOOP_LENGTH, type LoopRegion } from '../lib/replay';
import type { UseReplay } from '../hooks/useReplay';
import { CUE_TYPE_META, REPLAY_STATUS_META } from '../types';

interface ReplayBarProps {
  replay: UseReplay;
  /** 调度总时长（秒） */
  totalDuration: number;
  /** 设置循环区间失败等场景的轻提示 */
  onToast?: (msg: string) => void;
}

/**
 * 排练回放控制条（画布下方）：
 * 演出时钟、播放 / 暂停 / 继续 / 重置、可拖动时间轴、循环区间与到点提示列表。
 * 节点状态完全由当前时钟经调度时间轴推导，暂停 / 继续 / 拖动都会重算。
 *
 * 循环区间：在时间轴上方的循环条上拖动框选，或用「入点 / 出点」按钮取当前
 * 时刻；启用后播放到出点自动回到入点进入下一轮，区间内提示按轮重新触发
 * （同一轮不重复），区间外已完成提示仍不重复。
 */
export function ReplayBar({ replay, totalDuration, onToast }: ReplayBarProps) {
  const { time, isPlaying, playbackState, snapshot, alerts, firedIds, loop, loopIteration } = replay;
  const total = Math.max(0, totalDuration);
  const ended = total > 0 && time >= total - 1e-6 && !isPlaying;
  const atEnd = total > 0 && time >= total - 1e-6;
  const playIcon = isPlaying ? '⏸' : atEnd ? '↻' : '▶';
  const playTitle = isPlaying ? '暂停' : atEnd ? '从头播放' : playbackState === 'idle' ? '开始排练' : '继续';
  const stateText = isPlaying ? '播放中' : ended ? '已结束' : playbackState === 'idle' ? '待开始' : '已暂停';

  const runningCount = snapshot.runningIds.length;
  const doneCount = snapshot.doneIds.length;
  const waitingCount = snapshot.waitingIds.length;

  const progressPct = useMemo(() => (total > 0 ? Math.min(100, (time / total) * 100) : 0), [time, total]);

  // ---- 循环区间 ----
  const handleSetIn = useCallback(() => {
    if (!replay.setLoopIn(time)) {
      onToast?.(`无法设置入点：需比出点早至少 ${MIN_LOOP_LENGTH} 秒（可先清除或先调整出点）`);
    }
  }, [replay, time, onToast]);

  const handleSetOut = useCallback(() => {
    if (!replay.setLoopOut(time)) {
      onToast?.(`无法设置出点：需比入点晚至少 ${MIN_LOOP_LENGTH} 秒（可先清除或先调整入点）`);
    }
  }, [replay, time, onToast]);

  // 循环条拖动框选：按下记录锚点，移动更新预览，松开提交区间
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragAnchorRef = useRef<number | null>(null);
  const [dragRegion, setDragRegion] = useState<LoopRegion | null>(null);

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el || total <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * total;
    },
    [total],
  );

  const onStripPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (total <= 0) return;
      e.preventDefault();
      const t = timeAtClientX(e.clientX);
      dragAnchorRef.current = t;
      setDragRegion({ start: t, end: t });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 某些环境不支持指针捕获，拖动仍在元素内生效 */
      }
    },
    [total, timeAtClientX],
  );

  const onStripPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const anchor = dragAnchorRef.current;
      if (anchor === null) return;
      const t = timeAtClientX(e.clientX);
      setDragRegion({ start: Math.min(anchor, t), end: Math.max(anchor, t) });
    },
    [timeAtClientX],
  );

  const endStripDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
      const anchor = dragAnchorRef.current;
      if (anchor === null) return;
      dragAnchorRef.current = null;
      setDragRegion(null);
      if (!commit) return;
      const t = timeAtClientX(e.clientX);
      const a = Math.min(anchor, t);
      const b = Math.max(anchor, t);
      // 过短的框选（含单击）直接忽略，避免误触
      if (b - a >= MIN_LOOP_LENGTH) {
        replay.setLoopRegion(a, b);
      }
    },
    [timeAtClientX, replay],
  );

  // 循环条上展示的区间：拖动预览优先，其次已设置的区间
  const shownRegion = dragRegion ?? loop;
  const regionClass = dragRegion ? 'region-drag' : loop && !loop.enabled ? 'region-disabled' : '';

  return (
    <footer className="replay-bar" data-state={playbackState}>
      <div className="replay-row replay-row-controls">
        <div className="replay-state">
          <span className={`replay-state-dot ${isPlaying ? 'dot-playing' : ended ? 'dot-ended' : 'dot-idle'}`} />
          <span className="replay-state-text">排练回放 · {stateText}</span>
        </div>

        <div className="replay-transport">
          <button
            className="btn btn-play"
            onClick={replay.toggle}
            disabled={total <= 0}
            title={playTitle}
          >
            {playIcon} {isPlaying ? '暂停' : atEnd ? '重播' : '播放'}
          </button>
          <button
            className="btn"
            onClick={replay.reset}
            disabled={playbackState === 'idle'}
            title="重置回放：时钟回到 T+0 并清空提示（保留循环区间）"
          >
            ⏹ 重置
          </button>
        </div>

        <div className="replay-loop">
          <button
            className="btn btn-loop-pt"
            onClick={handleSetIn}
            disabled={total <= 0}
            title="将当前时刻设为循环入点（也可在下方循环条上拖动框选）"
          >
            ⇤ 入点
          </button>
          <button
            className="btn btn-loop-pt"
            onClick={handleSetOut}
            disabled={total <= 0}
            title="将当前时刻设为循环出点（也可在下方循环条上拖动框选）"
          >
            出点 ⇥
          </button>
          <button
            className={`btn btn-loop-toggle ${loop?.enabled ? 'loop-on' : ''}`}
            onClick={replay.toggleLoop}
            disabled={!loop}
            title={loop?.enabled ? '停用循环（保留区间）' : loop ? '启用循环' : '先在循环条上拖动或设定入点 / 出点'}
          >
            🔁 {loop ? (loop.enabled ? '循环中' : '已停用') : '循环'}
          </button>
          <button
            className="btn btn-loop-clear"
            onClick={replay.clearLoop}
            disabled={!loop}
            title="清除循环区间"
          >
            ✕
          </button>
          <span
            className={`replay-loop-info ${loop?.enabled ? 'loop-active' : ''}`}
            title="循环区间与当前轮次；循环回退时区间内提示按轮重新触发"
          >
            {loop
              ? `T+${formatClock(loop.start)} → T+${formatClock(loop.end)}${loop.enabled ? ` · 第 ${loopIteration} 轮` : ''}`
              : '未设置循环'}
          </span>
        </div>

        <div className="replay-clock" title="当前演出时钟（T+0 = 演出开始）">
          <span className="replay-clock-current">T+{formatClock(time)}</span>
          <span className="replay-clock-sep">/</span>
          <span className="replay-clock-total">{formatClock(total)}</span>
        </div>

        <div className="replay-counts">
          <span className="replay-count count-waiting">
            {REPLAY_STATUS_META.waiting.icon} 待触发 <strong>{waitingCount}</strong>
          </span>
          <span className="replay-count count-running">
            {REPLAY_STATUS_META.running.icon} 进行中 <strong>{runningCount}</strong>
          </span>
          <span className="replay-count count-done">
            {REPLAY_STATUS_META.done.icon} 已完成 <strong>{doneCount}</strong>
          </span>
        </div>

        <div className="replay-alerts" title="播放时钟越过节点触发时刻时产生到点提示；循环回退后区间内提示按轮重新触发，区间外已完成提示不重复">
          <span className="replay-alerts-head">
            🔔 到点提示
            {firedIds.size > 0 ? <em className="replay-alerts-num">{firedIds.size}</em> : null}
          </span>
          <div className="replay-alerts-scroll">
            {alerts.length === 0 ? (
              <span className="replay-alerts-empty">暂无提示</span>
            ) : (
              alerts.slice(0, 8).map((a, i) => (
                <span key={a.id} className={`replay-alert-item alert-${a.cueType} ${i === 0 ? 'alert-latest' : ''}`}>
                  <span className="alert-clock">T+{formatClock(a.at)}</span>
                  {loop?.enabled || a.iteration > 1 ? (
                    <em className="alert-iter" title={`第 ${a.iteration} 轮`}>R{a.iteration}</em>
                  ) : null}
                  <span className="alert-icon">{CUE_TYPE_META[a.cueType].icon}</span>
                  <span className="alert-label" title={a.label}>{a.label}</span>
                </span>
              ))
            )}
          </div>
          {alerts.length > 0 ? (
            <button className="replay-alerts-clear" onClick={replay.clearAlerts} title="清空提示列表（不影响回放进度）">
              清空
            </button>
          ) : null}
        </div>
      </div>

      <div className="replay-row replay-row-timeline">
        <span className="replay-tick">T+0</span>
        <div className="replay-track">
          <div
            ref={stripRef}
            className={`replay-loop-strip ${total <= 0 ? 'strip-disabled' : ''}`}
            title="拖动框选循环区间（入点 → 出点）"
            onPointerDown={onStripPointerDown}
            onPointerMove={onStripPointerMove}
            onPointerUp={(e) => endStripDrag(e, true)}
            onPointerCancel={(e) => endStripDrag(e, false)}
          >
            {shownRegion && total > 0 ? (
              <div
                className={`replay-loop-region ${regionClass}`}
                style={{
                  left: `${(shownRegion.start / total) * 100}%`,
                  width: `${((shownRegion.end - shownRegion.start) / total) * 100}%`,
                }}
              />
            ) : null}
          </div>
          <input
            className="replay-scrubber"
            type="range"
            min={0}
            max={total || 0}
            step={0.1}
            value={time}
            disabled={total <= 0}
            aria-label="排练回放时间轴"
            style={{ ['--progress' as string]: `${progressPct}%` }}
            onChange={(e) => replay.seek(Number(e.target.value))}
          />
        </div>
        <span className="replay-tick">T+{formatClock(total)}</span>
      </div>
    </footer>
  );
}
