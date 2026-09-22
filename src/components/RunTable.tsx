import { useEffect, useMemo, useRef, useState } from 'react';
import { CUE_TYPE_META, REPLAY_STATUS_META, type CueType, type ReplayStatus } from '../types';
import type { ScheduleResult } from '../lib/schedule';
import type { CueFlowNode } from './CueNode';

interface RunTableProps {
  nodes: CueFlowNode[];
  schedule: ScheduleResult;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 排练回放时传入各节点当前状态，运行表将显示「待触发 / 进行中 / 已完成」列 */
  statusById?: Map<string, ReplayStatus> | null;
}

type SortKey =
  | 'label'
  | 'cueType'
  | 'resource'
  | 'earliestStart'
  | 'duration'
  | 'delay'
  | 'earliestEnd'
  | 'latestStart'
  | 'slack';

const COLUMNS: Array<{ key: SortKey; title: string }> = [
  { key: 'label', title: '名称' },
  { key: 'cueType', title: '类型' },
  { key: 'resource', title: '资源' },
  { key: 'earliestStart', title: '最早触发' },
  { key: 'duration', title: '持续' },
  { key: 'delay', title: '延迟' },
  { key: 'earliestEnd', title: '结束' },
  { key: 'latestStart', title: '最晚触发' },
  { key: 'slack', title: '松弛' },
];

function fmt(v: number): string {
  return `${Number(v.toFixed(1))}s`;
}

/** 可排序运行表：与画布联动高亮（选中同步 + 关键路径同步 + 回放状态同步） */
export function RunTable({ nodes, schedule, selectedId, onSelect, statusById }: RunTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('earliestStart');
  const [sortAsc, setSortAsc] = useState(true);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const rows = useMemo(() => {
    const list = nodes.map((n) => {
      const s = schedule.byId.get(n.id);
      return {
        id: n.id,
        label: n.data.label,
        cueType: n.data.cueType,
        resource: (n.data.resource ?? '').trim(),
        duration: n.data.duration,
        delay: n.data.delay,
        earliestStart: s?.earliestStart ?? 0,
        earliestEnd: s?.earliestEnd ?? 0,
        latestStart: s?.latestStart ?? 0,
        slack: s?.slack ?? 0,
        critical: s?.critical ?? false,
        runStatus: statusById?.get(n.id) ?? null,
      };
    });
    const dir = sortAsc ? 1 : -1;
    list.sort((a, b) => {
      const ka = a[sortKey];
      const kb = b[sortKey];
      let cmp: number;
      if (typeof ka === 'string' && typeof kb === 'string') {
        cmp = ka.localeCompare(kb, 'zh-Hans-CN');
      } else {
        cmp = Number(ka) - Number(kb);
      }
      if (cmp === 0) cmp = a.earliestStart - b.earliestStart;
      return cmp * dir;
    });
    return list;
  }, [nodes, schedule, sortKey, sortAsc, statusById]);

  // 画布中选中节点时，运行表滚动到对应行
  useEffect(() => {
    if (selectedId) {
      rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedId]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  return (
    <section className="run-table">
      <h2 className="panel-title">运行表（点击表头排序）</h2>
      <div className="run-table-scroll">
        <table>
          <thead>
            <tr>
              {statusById ? <th className="th-run-status">回放</th> : null}
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={sortKey === c.key ? 'sorted' : ''}
                >
                  {c.title}
                  {sortKey === c.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + (statusById ? 1 : 0)} className="panel-empty">
                  暂无节点，请使用左上角按钮添加。
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(r.id, el);
                    else rowRefs.current.delete(r.id);
                  }}
                  className={`${r.critical ? 'row-critical' : ''} ${r.id === selectedId ? 'row-selected' : ''} ${r.runStatus ? `row-run-${r.runStatus}` : ''}`}
                  onClick={() => onSelect(r.id)}
                >
                  {r.runStatus ? (
                    <td>
                      <span className={`run-cell-badge run-cell-${r.runStatus}`}>
                        {REPLAY_STATUS_META[r.runStatus].icon} {REPLAY_STATUS_META[r.runStatus].label}
                      </span>
                    </td>
                  ) : statusById ? (
                    <td className="run-cell-na">—</td>
                  ) : null}
                  <td className="cell-label" title={r.label}>
                    {r.label}
                  </td>
                  <td>
                    <span className={`type-badge type-${r.cueType}`}>
                      {CUE_TYPE_META[r.cueType as CueType].icon}{' '}
                      {CUE_TYPE_META[r.cueType as CueType].label}
                    </span>
                  </td>
                  <td className="cell-resource">
                    {r.resource ? <span className="res-tag" title={`占用资源：${r.resource}`}>🎚 {r.resource}</span> : <span className="res-none">—</span>}
                  </td>
                  <td className="num">{fmt(r.earliestStart)}</td>
                  <td className="num">{fmt(r.duration)}</td>
                  <td className="num">{fmt(r.delay)}</td>
                  <td className="num">{fmt(r.earliestEnd)}</td>
                  <td className="num">{fmt(r.latestStart)}</td>
                  <td className={`num ${r.critical ? 'critical-text' : ''}`}>{fmt(r.slack)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
