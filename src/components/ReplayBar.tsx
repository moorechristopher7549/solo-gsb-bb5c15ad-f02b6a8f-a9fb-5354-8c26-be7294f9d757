import { useMemo } from 'react';
import { formatClock } from '../lib/replay';
import type { UseReplay } from '../hooks/useReplay';
import { CUE_TYPE_META, REPLAY_STATUS_META } from '../types';

interface ReplayBarProps {
  replay: UseReplay;
  /** 调度总时长（秒） */
  totalDuration: number;
}

/**
 * 排练回放控制条（画布下方）：
 * 演出时钟、播放 / 暂停 / 继续 / 重置、可拖动时间轴与到点提示列表。
 * 节点状态完全由当前时钟经调度时间轴推导，暂停 / 继续 / 拖动都会重算。
 */
export function ReplayBar({ replay, totalDuration }: ReplayBarProps) {
  const { time, isPlaying, playbackState, snapshot, alerts, firedIds } = replay;
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
            title="重置回放：时钟回到 T+0 并清空提示"
          >
            ⏹ 重置
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

        <div className="replay-alerts" title="播放时钟越过节点触发时刻时产生到点提示；拖动跳转不会重复提示已完成节点">
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
        <span className="replay-tick">T+{formatClock(total)}</span>
      </div>
    </footer>
  );
}
