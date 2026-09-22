import type { Edge } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import type { CueFlowNode } from './components/CueNode';
import { layeredLayout } from './lib/schedule';
import type { CueType } from './types';

interface SampleNode {
  id: string;
  label: string;
  cueType: CueType;
  duration: number;
  delay: number;
  /** 占用的舞台资源名，空串表示不占用 */
  resource?: string;
  position?: { x: number; y: number };
}

// n1 / n4 / n7 共用「追光1」：无依赖关系也会自动串行（注意 n1 在数组中先于 n4）；
// n3 / n8 共用「麦克风A」：演示资源约束对最终时刻与关键路径的影响。
const SAMPLE_NODES: SampleNode[] = [
  { id: 'n1', label: '开场暖场光', cueType: 'lighting', duration: 4, delay: 0, resource: '追光1' },
  { id: 'n2', label: '开场音乐', cueType: 'sound', duration: 6, delay: 0 },
  { id: 'n3', label: '主持人上场', cueType: 'actor', duration: 3, delay: 1, resource: '麦克风A' },
  { id: 'n4', label: '追光定位', cueType: 'lighting', duration: 5, delay: 0, resource: '追光1' },
  { id: 'n5', label: '掌声音效', cueType: 'sound', duration: 2, delay: 0 },
  { id: 'n6', label: '全体谢幕', cueType: 'actor', duration: 4, delay: 2 },
  { id: 'n7', label: '收场追光', cueType: 'lighting', duration: 8, delay: 0, resource: '追光1' },
  { id: 'n8', label: '主持人口播', cueType: 'actor', duration: 3, delay: 0, resource: '麦克风A' },
];

const SAMPLE_EDGES: Array<[string, string]> = [
  ['n1', 'n3'],
  ['n2', 'n3'],
  ['n3', 'n4'],
  ['n3', 'n5'],
  ['n3', 'n8'],
  ['n4', 'n6'],
  ['n5', 'n6'],
  ['n6', 'n7'],
];

const FALLBACK_POS: Record<string, { x: number; y: number }> = {
  n1: { x: 60, y: 60 },
  n2: { x: 60, y: 220 },
  n3: { x: 380, y: 140 },
  n4: { x: 700, y: 40 },
  n5: { x: 700, y: 220 },
  n8: { x: 700, y: 360 },
  n6: { x: 1020, y: 140 },
  n7: { x: 1340, y: 60 },
};

/** 内置示例演出：含并行分支与共享资源，演示关键路径与资源串行 */
export function createSampleShow(): { nodes: CueFlowNode[]; edges: Edge[] } {
  const edges: Edge[] = SAMPLE_EDGES.map(([source, target]) => ({
    id: `e-${source}-${target}`,
    source,
    target,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  const auto = layeredLayout(SAMPLE_NODES, edges);
  const nodes: CueFlowNode[] = SAMPLE_NODES.map((n) => ({
    id: n.id,
    type: 'cue',
    position: n.position ?? FALLBACK_POS[n.id] ?? auto.get(n.id) ?? { x: 0, y: 0 },
    data: {
      label: n.label,
      cueType: n.cueType,
      duration: n.duration,
      delay: n.delay,
      resource: n.resource ?? '',
    },
  }));
  return { nodes, edges };
}
