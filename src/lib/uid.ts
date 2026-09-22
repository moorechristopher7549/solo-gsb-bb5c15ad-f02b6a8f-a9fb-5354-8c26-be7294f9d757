/** 生成短随机 id（不依赖 crypto.randomUUID，兼容非安全上下文） */
export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
