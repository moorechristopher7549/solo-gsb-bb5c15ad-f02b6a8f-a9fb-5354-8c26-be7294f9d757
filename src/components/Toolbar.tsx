import { useRef } from 'react';
import { CUE_TYPE_META, CUE_TYPES, type CueType } from '../types';

interface ToolbarProps {
  totalDuration: number;
  criticalCount: number;
  nodeCount: number;
  resourceCount: number;
  rehearsal: boolean;
  onToggleRehearsal: () => void;
  onAdd: (type: CueType) => void;
  onAutoLayout: () => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onClear: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">🎬</span>
        <span className="brand-name">CueFlow</span>
        <span className="brand-sub">舞台提示链编排</span>
      </div>

      <div className="toolbar-group">
        {CUE_TYPES.map((t) => (
          <button
            key={t}
            className={`btn btn-add btn-${t}`}
            onClick={() => props.onAdd(t)}
            title={`添加${CUE_TYPE_META[t].label}提示节点`}
          >
            {CUE_TYPE_META[t].icon} {CUE_TYPE_META[t].label}
          </button>
        ))}
      </div>

      <div className="toolbar-group">
        <button
          className={`btn btn-rehearsal ${props.rehearsal ? 'btn-rehearsal-on' : ''}`}
          onClick={props.onToggleRehearsal}
          title={props.rehearsal ? '退出排练回放，返回编排模式' : '进入排练回放：按调度时间轴播放并提示到点节点'}
        >
          {props.rehearsal ? '✎ 退出回放' : '▶ 排练回放'}
        </button>
      </div>

      <div className="toolbar-group">
        <button className="btn" onClick={props.onAutoLayout} title="按依赖层级自动排列节点">
          ⇥ 整理布局
        </button>
        <button className="btn" onClick={props.onExport} title="导出为 JSON 文件">
          ⬇ 导出 JSON
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} title="从 JSON 文件导入">
          ⬆ 导入 JSON
        </button>
        <button className="btn btn-danger" onClick={props.onClear} title="清空全部节点与连线">
          ✕ 清空
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onImportFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <div className="toolbar-stats">
        <span className="stat">
          总时长 <strong>{props.totalDuration.toFixed(1)}s</strong>
        </span>
        <span className="stat">
          资源 <strong>{props.resourceCount}</strong>
        </span>
        <span className="stat">
          关键路径 <strong className="critical-text">{props.criticalCount}</strong> / {props.nodeCount} 节点
        </span>
      </div>
    </header>
  );
}
