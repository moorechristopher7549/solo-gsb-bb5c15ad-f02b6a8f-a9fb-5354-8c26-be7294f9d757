import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { CueNode, type CueFlowNode } from './components/CueNode';
import { Inspector } from './components/Inspector';
import { ReplayBar } from './components/ReplayBar';
import { ResourceBoard } from './components/ResourceBoard';
import { RunTable } from './components/RunTable';
import { Toolbar } from './components/Toolbar';
import { parseShow, serializeShow } from './lib/io';
import { buildTimeline } from './lib/replay';
import {
  combinedGraphHasCycle,
  computeSchedule,
  layeredLayout,
  normalizeResource,
  wouldCreateCycleWithResources,
} from './lib/schedule';
import { useReplay } from './hooks/useReplay';
import { uid } from './lib/uid';
import { createSampleShow } from './sample';
import { CUE_TYPE_META, type CueNodeData, type CueType } from './types';

const nodeTypes = { cue: CueNode };

const EDGE_STYLE = { stroke: '#5b6b8c', strokeWidth: 1.6 };
const EDGE_STYLE_CRITICAL = { stroke: '#ff5a5a', strokeWidth: 2.6 };
/** 资源串行合成连线：与显式依赖的实线区分，使用金色虚线 */
const RES_EDGE_STYLE = { stroke: '#d8b46a', strokeWidth: 1.6, strokeDasharray: '6 4' };
const RES_EDGE_STYLE_CRITICAL = { stroke: '#ff5a5a', strokeWidth: 2.6, strokeDasharray: '6 4' };

const sample = createSampleShow();

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CueFlowNode>(sample.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(sample.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 排练回放模式：展示节点回放状态与控制条；编排模式下隐藏 */
  const [rehearsal, setRehearsal] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const rfInstance = useRef<ReactFlowInstance<CueFlowNode, Edge> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  // 任一节点 / 连线变更后，按依赖 + 资源串行重算最早/最晚时刻与关键路径
  const schedule = useMemo(() => computeSchedule(nodes, edges), [nodes, edges]);

  // ---- 排练回放：按当前调度结果建立时间轴 ----
  // earliestStart / earliestEnd 已包含显式依赖与资源串行等待，回放直接沿用
  const timeline = useMemo(() => buildTimeline(nodes, schedule), [nodes, schedule]);
  const replay = useReplay({ timeline, totalDuration: schedule.totalDuration });

  // 注入计算结果（最早触发时刻、是否关键）供节点渲染
  const displayNodes = useMemo<CueFlowNode[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          earliestStart: schedule.byId.get(n.id)?.earliestStart,
          critical: schedule.criticalNodeIds.has(n.id),
          runStatus: rehearsal ? replay.snapshot.statusById.get(n.id) : undefined,
        },
      })),
    [nodes, schedule, rehearsal, replay.snapshot],
  );

  const displayEdges = useMemo<Edge[]>(() => {
    const realEdges = edges.map((e) => {
      const critical = schedule.criticalEdgeIds.has(e.id);
      return {
        ...e,
        animated: critical,
        style: critical ? EDGE_STYLE_CRITICAL : EDGE_STYLE,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: critical ? '#ff5a5a' : '#5b6b8c',
        },
      };
    });
    // 资源串行合成连线：仅展示，不可选中 / 删除 / 再次连线
    const resourceEdges: Edge[] = schedule.resourceLinks.map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      sourceHandle: null,
      targetHandle: null,
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      deletable: false,
      animated: link.critical,
      label: `🎚 ${link.resource}`,
      labelStyle: { fill: link.critical ? '#ff8f8f' : '#d8b46a', fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: '#1c2434', fillOpacity: 0.85 },
      style: link.critical ? RES_EDGE_STYLE_CRITICAL : RES_EDGE_STYLE,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: link.critical ? '#ff5a5a' : '#d8b46a',
      },
      zIndex: link.critical ? 1 : 0,
    }));
    return [...realEdges, ...resourceEdges];
  }, [edges, schedule]);

  // ---- 连线：阻止成环（依赖 + 资源串行共同构成的约束图） ----
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (wouldCreateCycleWithResources(nodes, edges, conn.source, conn.target)) {
        showToast('无法连接：该连线会与依赖或资源串行顺序形成环路');
        return;
      }
      setEdges((eds) =>
        addEdge({ ...conn, id: uid('e'), markerEnd: { type: MarkerType.ArrowClosed } }, eds),
      );
    },
    [nodes, edges, setEdges, showToast],
  );
  const isValidConnection = useCallback(
    (conn: Edge | Connection) => {
      if (!conn.source || !conn.target) return false;
      return !wouldCreateCycleWithResources(nodes, edges, conn.source, conn.target);
    },
    [nodes, edges],
  );

  // ---- 节点操作 ----
  const addCue = useCallback(
    (type: CueType) => {
      const id = uid('cue');
      const node: CueFlowNode = {
        id,
        type: 'cue',
        position: { x: 120 + (nodes.length % 5) * 36, y: 120 + (nodes.length % 6) * 30 },
        data: {
          label: `${CUE_TYPE_META[type].label}提示 ${nodes.length + 1}`,
          cueType: type,
          duration: 3,
          delay: 0,
          resource: '',
        },
        selected: true,
      };
      setNodes((nds) => [...nds.map((n): CueFlowNode => ({ ...n, selected: false })), node]);
      setSelectedId(id);
    },
    [nodes.length, setNodes],
  );

  const updateCue = useCallback(
    (id: string, patch: Partial<CueNodeData>) => {
      // 资源名修改后，资源串行顺序可能与显式依赖矛盾（成环），拒绝本次修改并恢复原值
      if (patch.resource !== undefined) {
        const candidate = nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, resource: normalizeResource(patch.resource) } } : n,
        );
        if (combinedGraphHasCycle(candidate, edges)) {
          showToast('该资源会与依赖顺序冲突：同资源提示按节点顺序串行，请调整资源或节点顺序');
          const prev = nodes.find((n) => n.id === id)?.data.resource ?? '';
          setNodes((nds) =>
            nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, resource: prev } } : n)),
          );
          return;
        }
        patch = { ...patch, resource: normalizeResource(patch.resource) };
      }
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [nodes, edges, setNodes, showToast],
  );

  const deleteCue = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      setSelectedId((sel) => (sel === id ? null : sel));
    },
    [setNodes, setEdges],
  );

  const selectNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
      setEdges((eds) => eds.map((e) => ({ ...e, selected: false })));
      setSelectedId(id);
    },
    [setNodes, setEdges],
  );

  const autoLayout = useCallback(() => {
    const pos = layeredLayout(nodes, edges);
    setNodes((nds) => nds.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    window.requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2, duration: 300 }));
  }, [nodes, edges, setNodes]);

  const clearAll = useCallback(() => {
    if (nodes.length === 0) return;
    if (!window.confirm('确定清空全部节点与连线？')) return;
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    replay.reset();
  }, [nodes.length, setNodes, setEdges, replay]);

  // ---- 排练回放模式开关 ----
  // 进入时从 T+0 开始；退出时停止播放并复位，保证再次进入状态干净
  const toggleRehearsal = useCallback(() => {
    replay.reset();
    setRehearsal((v) => !v);
  }, [replay]);

  // 已使用的资源名（去重），供属性面板输入联想
  const resourceOptions = useMemo(
    () => schedule.resources.map((r) => r.name),
    [schedule],
  );

  // ---- JSON 导入 / 导出 ----
  const exportJson = useCallback(() => {
    const text = serializeShow(nodes, edges);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cue-show.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出 JSON 文件');
  }, [nodes, edges, showToast]);

  const importJson = useCallback(
    async (file: File) => {
      const text = await file.text();
      const res = parseShow(text);
      if (!res.ok) {
        showToast(`导入失败：${res.error}`);
        return;
      }
      setNodes(
        res.nodes.map((n) => ({
          id: n.id,
          type: 'cue' as const,
          position: n.position,
          data: {
            label: n.label,
            cueType: n.cueType,
            duration: n.duration,
            delay: n.delay,
            resource: n.resource,
          },
          selected: false,
        })),
      );
      setEdges(
        res.edges.map((e) => ({
          ...e,
          markerEnd: { type: MarkerType.ArrowClosed },
        })),
      );
      setSelectedId(null);
      replay.reset();
      showToast(`已导入 ${res.nodes.length} 个节点、${res.edges.length} 条连线`);
      window.requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2 }));
    },
    [setNodes, setEdges, showToast, replay],
  );

  const selectedNode = useMemo(
    () => displayNodes.find((n) => n.id === selectedId) ?? null,
    [displayNodes, selectedId],
  );

  return (
    <div className="app">
      <Toolbar
        totalDuration={schedule.totalDuration}
        criticalCount={schedule.criticalNodeIds.size}
        nodeCount={nodes.length}
        resourceCount={schedule.resources.length}
        rehearsal={rehearsal}
        onToggleRehearsal={toggleRehearsal}
        onAdd={addCue}
        onAutoLayout={autoLayout}
        onExport={exportJson}
        onImportFile={(f) => void importJson(f)}
        onClear={clearAll}
      />
      <div className="main">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel.length > 0 ? sel[0].id : null)}
            onInit={(inst) => {
              rfInstance.current = inst;
            }}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            minZoom={0.2}
            maxZoom={2}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#2c3852" />
            <Controls position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => {
                const d = (n as CueFlowNode).data;
                if (rehearsal) {
                  if (d.runStatus === 'running') return '#49c268';
                  if (d.runStatus === 'done') return '#6ea8fe';
                }
                return d.critical
                  ? '#ff5a5a'
                  : { lighting: '#e8a13a', sound: '#3fa9f5', actor: '#c678dd' }[d.cueType];
              }}
            />
          </ReactFlow>
          {schedule.hasCycle ? (
            <div className="banner-error">
              检测到依赖与资源串行形成环路：调度结果可能不准确，请检查连线或资源节点顺序。
            </div>
          ) : null}
          {toast ? <div className="toast">{toast}</div> : null}
        </div>
        <aside className="sidebar">
          <Inspector
            node={selectedNode}
            schedule={selectedId ? schedule.byId.get(selectedId) ?? null : null}
            resourceOptions={resourceOptions}
            onChange={updateCue}
            onDelete={deleteCue}
          />
          <ResourceBoard
            schedule={schedule}
            selectedId={selectedId}
            onSelect={selectNode}
            statusById={rehearsal ? replay.snapshot.statusById : null}
          />
          <RunTable
            nodes={displayNodes}
            schedule={schedule}
            selectedId={selectedId}
            onSelect={selectNode}
            statusById={rehearsal ? replay.snapshot.statusById : null}
          />
        </aside>
      </div>
      {rehearsal ? <ReplayBar replay={replay} totalDuration={schedule.totalDuration} /> : null}
    </div>
  );
}
