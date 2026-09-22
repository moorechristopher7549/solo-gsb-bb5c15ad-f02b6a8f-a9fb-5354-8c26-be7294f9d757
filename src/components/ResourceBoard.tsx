import type { ScheduleResult } from '../lib/schedule';
import type { ReplayStatus } from '../types';

interface ResourceBoardProps {
  schedule: ScheduleResult;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 排练回放时传入各节点状态，资源队列项将同步显示待触发 / 进行中 / 已完成 */
  statusById?: Map<string, ReplayStatus> | null;
}

function fmt(v: number): string {
  return `${Number(v.toFixed(1))}s`;
}

/**
 * 舞台资源占用面板：按资源列出串行排程队列，
 * 每项给出排程区间 [最早触发, 最早结束]，关键项红色标记。
 */
export function ResourceBoard({ schedule, selectedId, onSelect, statusById }: ResourceBoardProps) {
  const resources = schedule.resources;

  return (
    <section className="res-board">
      <h2 className="panel-title">舞台资源占用（{resources.length}）</h2>
      {resources.length === 0 ? (
        <p className="panel-empty">
          暂无资源。在节点属性的「占用资源」中填写同名资源（如追光1、麦克风A），
          同资源提示将按节点顺序自动串行、不可重叠。
        </p>
      ) : (
        <div className="res-board-scroll">
          {resources.map((r) => (
            <div className="res-card" key={r.name}>
              <div className="res-card-head">
                <span className="res-card-name" title={r.name}>
                  🎚 {r.name}
                </span>
                <span className="res-card-busy">占用至 T+{fmt(r.busyUntil)}</span>
              </div>
              <ol className="res-queue">
                {r.queue.map((item, i) => {
                  const st = statusById?.get(item.nodeId) ?? null;
                  return (
                    <li
                      key={item.nodeId}
                      className={`res-item ${item.critical ? 'res-item-critical' : ''} ${
                        item.nodeId === selectedId ? 'res-item-selected' : ''
                      } ${st ? `res-item-run-${st}` : ''}`}
                      onClick={() => onSelect(item.nodeId)}
                      title={`${item.label}：T+${fmt(item.start)} ~ T+${fmt(item.end)}`}
                    >
                      <span className="res-item-index">{i + 1}</span>
                      {st ? <span className={`res-run-dot res-run-dot-${st}`} title={st} /> : null}
                      <span className="res-item-label">{item.label}</span>
                      <span className="res-item-range">
                        {fmt(item.start)}–{fmt(item.end)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
