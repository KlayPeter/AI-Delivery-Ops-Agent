export interface StatusPanel {
  schemaVersion: '1.0'; tone: 'neutral' | 'success' | 'warning' | 'error'; title: string; description?: string; checkedAt?: string;
  items?: { label: string; value: string; detail?: string }[];
  relatedRun?: { id: string; label: string };
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, optional = false) => optional && value === undefined || typeof value === 'string' && value.length <= max && (optional || value.length > 0);

export function parseStatusPanels(value: unknown): StatusPanel[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 20) return null;
  if (!value.every(panel => object(panel) && panel.schemaVersion === '1.0' && typeof panel.tone === 'string' && ['neutral', 'success', 'warning', 'error'].includes(panel.tone)
    && text(panel.title, 160) && text(panel.description, 2000, true)
    && (panel.checkedAt === undefined || typeof panel.checkedAt === 'string' && Number.isFinite(Date.parse(panel.checkedAt)))
    && (panel.items === undefined || Array.isArray(panel.items) && panel.items.length <= 20 && panel.items.every(item => object(item) && text(item.label, 1024) && text(item.value, 160) && text(item.detail, 2000, true)))
    && (panel.relatedRun === undefined || object(panel.relatedRun) && text(panel.relatedRun.id, 256) && text(panel.relatedRun.label, 80)))) return null;
  return value as StatusPanel[];
}
