import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CUE_TYPE_META, REPLAY_STATUS_META, type CueNodeData } from '../types';

export type CueFlowNode = Node<CueNodeData, 'cue'>;

function fmt(v: number): string {
  return `${Number(v.toFixed(1))}s`;
}

/** 自定义提示节点：按类型着色，展示时长 / 延迟 / 资源 / 最早触发时刻，关键路径高亮 */
export function CueNode({ data, selected }: NodeProps<CueFlowNode>) {
  const meta = CUE_TYPE_META[data.cueType];
  const resource = data.resource?.trim() ?? '';
  const runStatus = data.runStatus;
  const cls = [
    'cue-node',
    `cue-${data.cueType}`,
    data.critical ? 'critical' : '',
    selected ? 'selected' : '',
    runStatus ? `run-${runStatus}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} className="cue-handle" />
      <div className="cue-node-head">
        <span className="cue-icon">{meta.icon}</span>
        <span className="cue-label" title={data.label}>
          {data.label}
        </span>
        {data.critical && !runStatus ? <span className="cue-flag">关键</span> : null}
        {runStatus ? (
          <span className={`cue-run-badge cue-run-${runStatus}`}>
            {REPLAY_STATUS_META[runStatus].icon} {REPLAY_STATUS_META[runStatus].label}
          </span>
        ) : null}
      </div>
      <div className="cue-node-meta">
        <span>⏱ {fmt(data.duration)}</span>
        {data.delay > 0 ? <span>⏳ +{fmt(data.delay)}</span> : null}
      </div>
      {resource ? (
        <div className="cue-node-res" title={`占用舞台资源：${resource}`}>
          🎚 {resource}
        </div>
      ) : null}
      {typeof data.earliestStart === 'number' ? (
        <div className="cue-node-time">T+{fmt(data.earliestStart)}</div>
      ) : null}
      <Handle type="source" position={Position.Right} className="cue-handle" />
    </div>
  );
}
