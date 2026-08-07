import type { DiffEntry, SyncItem } from './types';

export interface MergeResult {
    merged: Record<string, SyncItem>;
    conflicts: DiffEntry[];
}

/** 3-way merge ต่อ item — ห้ามใช้ mtime ตัดสิน conflict */
export function mergeManifestItems(
    ancestor: Record<string, SyncItem>,
    a: Record<string, SyncItem>,
    b: Record<string, SyncItem>,
): MergeResult {
    const merged: Record<string, SyncItem> = {};
    const conflicts: DiffEntry[] = [];
    const ids = new Set([...Object.keys(ancestor), ...Object.keys(a), ...Object.keys(b)]);
    for (const id of ids) {
        const base = ancestor[id];
        const ai = a[id];
        const bi = b[id];
        const aChanged = (ai?.hash ?? null) !== (base?.hash ?? null);
        const bChanged = (bi?.hash ?? null) !== (base?.hash ?? null);
        if (!aChanged && !bChanged) { if (base) merged[id] = base; continue; }
        if (aChanged && !bChanged) { if (ai) merged[id] = ai; continue; }
        if (!aChanged && bChanged) { if (bi) merged[id] = bi; continue; }
        // ทั้งคู่เปลี่ยน
        if ((ai?.hash ?? null) === (bi?.hash ?? null)) { if (ai) merged[id] = ai; continue; }
        conflicts.push({ id, action: 'conflict', type: ai?.type ?? bi?.type ?? base?.type, local: ai, remote: bi, base });
    }
    return { merged, conflicts };
}
