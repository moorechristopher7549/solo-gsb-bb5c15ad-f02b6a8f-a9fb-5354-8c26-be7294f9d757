import { useMemo } from 'react';
import { formatClock } from '../lib/replay';
import type { UseReplay } from '../hooks/useReplay';
import { CUE_TYPE_META, REPLAY_STATUS_META } from '../types';

interface ReplayBarProps {
  replay: UseReplay;
  /** 调度总时长（秒） */
  totalDuration: number;
}

/** 时间轴底色 / 已播放色（与 CSS 中 .replay-scrubber 保持一致） */
const TRACK_RGB = [42, 53, 80] as const;
const PROGRESS_RGB = [110, 168, 254] as const;
/** 循环区间覆盖色（绿），与底色混合后形成区间色带 */
const LOOP_RGB = [73, 194, 104] as const;
const LOOP_ALPHA = 0.5;

const rgb = (c: readonly [number, number, number] | readonly number[]) =>
  `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const overLoop = (base: readonly number[]) =>
  rgb(
    base.map((c, i) =>
      Math.round(LOOP_ALPHA * LOOP_RGB[i] + (1 - LOOP_ALPHA) * c),
    ),
  );

/**
 * 排练回放控制条（画布下方）：
 * 演出时钟、播放 / 暂停 / 继续 / 重置、可拖动时间轴、循环入 / 出点与到点提示列表。
 * 节点状态完全由当前时钟经调度时间轴推导，暂停 / 继续 / 拖动都会重算。
 */
export function ReplayBar({ replay, totalDuration }: ReplayBarProps) {
  const { time, isPlaying, playbackState, snapshot, alerts, firedIds, loop, round } = replay;
  const total = Math.max(0, totalDuration);
  const ended = total > 0 && time >= total - 1e-6 && !isPlaying;
  const atEnd = total > 0 && time >= total - 1e-6;
  const playIcon = isPlaying ? '⏸' : atEnd ? '↻' : '▶';
  const playTitle = isPlaying ? '暂停' : atEnd ? '从头播放' : playbackState === 'idle' ? '开始排练' : '继续';
  const stateText = isPlaying
    ? '播放中'
    : ended
      ? '已结束'
      : playbackState === 'idle'
        ? '待开始'
        : '已暂停';

  const runningCount = snapshot.runningIds.length;
  const doneCount = snapshot.doneIds.length;
  const waitingCount = snapshot.waitingIds.length;

  const progressPct = useMemo(() => (total > 0 ? Math.min(100, (time / total) * 100) : 0), [time, total]);

  const loopPct = useMemo(
    () =>
      loop && total > 0
        ? { in: (loop.inPoint / total) * 100, out: (loop.outPoint / total) * 100 }
        : null,
    [loop, total],
  );

  // 时间轴背景：已播放蓝条 + 循环区间绿色色带（分别与底色 / 蓝条混合）
  const scrubberStyle = useMemo(() => {
    const progress = progressPct;
    if (!loopPct) {
      return {
        ['--progress' as string]: `${progress}%`,
      };
    }
    const { in: lin, out: lout } = loopPct;
    const colorAt = (x: number) => {
      const base = x <= progress + 1e-9 ? PROGRESS_RGB : TRACK_RGB;
      const inBand = x + 1e-9 >= lin && x <= lout + 1e-9;
      return inBand ? overLoop(base) : rgb(base);
    };
    const bounds = [0, lin, lout, 100];
    if (progress > 1e-9 && progress < 100 - 1e-9) bounds.push(progress);
    bounds.sort((a, b) => a - b);
    const stops: string[] = [];
    for (let i = 0; i < bounds.length; i += 1) {
      const x = bounds[i];
      if (i > 0) stops.push(`${colorAt(x - 1e-6)} ${x}%`);
      stops.push(`${colorAt(x)} ${x}%`);
    }
    return {
      ['--scrubber-bg' as string]: `linear-gradient(to right, ${stops.join(', ')})`,
    };
  }, [loopPct, progressPct]);

  return (
    <footer className="replay-bar" data-state={playbackState} data-loop={loop ? 'on' : 'off'}>
      <div className="replay-row replay-row-controls">
        <div className="replay-state">
          <span className={`replay-state-dot ${isPlaying ? 'dot-playing' : ended ? 'dot-ended' : 'dot-idle'}`} />
          <span className="replay-state-text">
            排练回放 · {stateText}
            {loop ? <em className="replay-state-loop">🔁 循环 · 第 {round} 轮</em> : null}
          </span>
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

        <div
          className={`replay-loop ${loop ? 'is-active' : ''}`}
          title="在时间轴上设置入点 / 出点并循环：播放到出点自动回到入点；区间内提示每轮重新触发，区间外不重复"
        >
          <button
            className={`btn btn-loop-toggle ${loop ? 'btn-loop-on' : ''}`}
            onClick={replay.toggleLoop}
            disabled={total <= 0}
            title={loop ? '关闭循环（区间设置保留，可再次开启）' : '启用循环（未设置入 / 出点时循环整场）'}
          >
            🔁 {loop ? '循环中' : '循环'}
          </button>
          <button
            className="btn btn-loop-point"
            onClick={() => replay.setLoopIn()}
            disabled={total <= 0}
            title={`在当前时钟 T+${formatClock(time)} 设置入点${loop ? `（当前 T+${formatClock(loop.inPoint)}）` : ''}`}
          >
            ⇱ 入点
          </button>
          <button
            className="btn btn-loop-point"
            onClick={() => replay.setLoopOut()}
            disabled={total <= 0}
            title={`在当前时钟 T+${formatClock(time)} 设置出点${loop ? `（当前 T+${formatClock(loop.outPoint)}）` : ''}`}
          >
            出点 ⇲
          </button>
          <span className="replay-loop-range">
            {loop ? (
              <>
                <span className="loop-range-in">T+{formatClock(loop.inPoint)}</span>
                <span className="loop-range-sep">→</span>
                <span className="loop-range-out">T+{formatClock(loop.outPoint)}</span>
                <em className="replay-loop-round">第 {round} 轮</em>
              </>
            ) : (
              <span className="loop-range-empty">整场</span>
            )}
          </span>
          <button
            className="btn btn-loop-clear"
            onClick={replay.clearLoop}
            disabled={!loop}
            title="清除循环区间并关闭循环（播放进度与提示记录不变）"
          >
            ✕ 清除
          </button>
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

        <div className="replay-alerts" title="播放时钟越过节点触发时刻时产生到点提示；循环区间内提示每轮重新触发，区间外与拖动跳转不重复">
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
                  {a.round > 1 ? <em className="alert-round" title={`第 ${a.round} 轮循环重新触发`}>⟳{a.round}</em> : null}
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
        <div className="replay-scrub-wrap">
          <input
            className="replay-scrubber"
            type="range"
            min={0}
            max={total || 0}
            step={0.1}
            value={time}
            disabled={total <= 0}
            aria-label="排练回放时间轴"
            style={scrubberStyle}
            onChange={(e) => replay.seek(Number(e.target.value))}
          />
          {loopPct ? (
            <>
              <span
                className="loop-flag loop-flag-in"
                style={{ left: `${loopPct.in}%` }}
                title={`循环入点 T+${formatClock(loop?.inPoint ?? 0)}`}
              />
              <span
                className="loop-flag loop-flag-out"
                style={{ left: `${loopPct.out}%` }}
                title={`循环出点 T+${formatClock(loop?.outPoint ?? 0)}`}
              />
            </>
          ) : null}
        </div>
        <span className="replay-tick">T+{formatClock(total)}</span>
      </div>
    </footer>
  );
}
