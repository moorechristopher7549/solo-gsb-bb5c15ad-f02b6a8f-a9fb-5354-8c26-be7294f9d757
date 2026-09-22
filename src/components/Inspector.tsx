import { CUE_TYPE_META, CUE_TYPES, type CueNodeData, type CueType } from '../types';
import type { NodeSchedule } from '../lib/schedule';
import type { CueFlowNode } from './CueNode';

interface InspectorProps {
  node: CueFlowNode | null;
  schedule: NodeSchedule | null;
  /** 画布中已使用的资源名，用于输入联想 */
  resourceOptions: string[];
  onChange: (id: string, patch: Partial<CueNodeData>) => void;
  onDelete: (id: string) => void;
}

function fmt(v: number): string {
  return `${Number(v.toFixed(1))}s`;
}

/** 右侧属性面板：编辑选中节点的名称 / 类型 / 持续时间 / 相对延迟 / 占用资源 */
export function Inspector({ node, schedule, resourceOptions, onChange, onDelete }: InspectorProps) {
  if (!node) {
    return (
      <section className="inspector">
        <h2 className="panel-title">节点属性</h2>
        <p className="panel-empty">
          在画布中点击节点进行编辑；拖动节点右下角手柄到另一节点即可建立依赖。
          在「占用资源」中填写资源名（如追光1、麦克风A），同一资源上的提示会自动串行。
        </p>
      </section>
    );
  }

  const d = node.data;
  const num = (v: string, fallback: number): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return (
    <section className="inspector">
      <h2 className="panel-title">
        节点属性
        {schedule?.critical ? <span className="badge badge-critical">关键路径</span> : null}
      </h2>

      <label className="field">
        <span>名称</span>
        <input
          type="text"
          value={d.label}
          onChange={(e) => onChange(node.id, { label: e.target.value })}
        />
      </label>

      <label className="field">
        <span>类型</span>
        <select
          value={d.cueType}
          onChange={(e) => onChange(node.id, { cueType: e.target.value as CueType })}
        >
          {CUE_TYPES.map((t) => (
            <option key={t} value={t}>
              {CUE_TYPE_META[t].icon} {CUE_TYPE_META[t].label}
            </option>
          ))}
        </select>
      </label>

      <div className="field-row">
        <label className="field">
          <span>持续时间（秒）</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={d.duration}
            onChange={(e) => onChange(node.id, { duration: num(e.target.value, d.duration) })}
          />
        </label>
        <label className="field">
          <span>相对延迟（秒）</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={d.delay}
            onChange={(e) => onChange(node.id, { delay: num(e.target.value, d.delay) })}
          />
        </label>
      </div>

      <label className="field">
        <span>占用资源（留空表示不占用）</span>
        <input
          type="text"
          list="cue-resource-list"
          placeholder="如：追光1、麦克风A"
          value={d.resource}
          onChange={(e) => onChange(node.id, { resource: e.target.value })}
        />
        <datalist id="cue-resource-list">
          {resourceOptions.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </label>

      {schedule ? (
        <dl className="computed">
          <div>
            <dt>最早触发</dt>
            <dd>{fmt(schedule.earliestStart)}</dd>
          </div>
          <div>
            <dt>最早结束</dt>
            <dd>{fmt(schedule.earliestEnd)}</dd>
          </div>
          <div>
            <dt>最晚触发</dt>
            <dd>{fmt(schedule.latestStart)}</dd>
          </div>
          <div>
            <dt>松弛时间</dt>
            <dd className={schedule.critical ? 'critical-text' : ''}>{fmt(schedule.slack)}</dd>
          </div>
        </dl>
      ) : null}

      <button className="btn btn-danger btn-block" onClick={() => onDelete(node.id)}>
        删除节点（或按 Delete 键）
      </button>
    </section>
  );
}
