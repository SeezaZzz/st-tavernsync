import { describe, it, expect, vi } from 'vitest';
import { applyOp } from '../apply';
import type { ApplyOp } from '../types';

function ctx(onProgress?: (p: number, t: number) => void) {
    return {
        dryRun: false,
        log: () => {},
        pushBlob: vi.fn(async () => {}),
        pullAndApply: vi.fn(async () => {}),
        keepBoth: vi.fn(async () => {}),
        tombstone: vi.fn(async () => {}),
        onProgress,
    };
}

const push = (id: string): ApplyOp => ({ id, kind: 'push_blob', type: 'preset', hash: `h-${id}` });
const skip = (id: string): ApplyOp => ({ id, kind: 'skip', type: 'preset' });

describe('applyOp progress', () => {
    it('ส่ง push ทั้งก้อนครั้งเดียวและนับ progress จากแต่ละรายการที่เสร็จ', async () => {
        const seen: Array<[number, number]> = [];
        const pushBlobs = vi.fn(async (
            items: readonly { readonly id: string; readonly hash: string }[],
            onProcessed: (item: { readonly id: string; readonly hash: string }) => void,
        ) => {
            for (const item of items) onProcessed(item);
        });
        const context = { ...ctx((p, t) => seen.push([p, t])), pushBlobs };

        const result = await applyOp([push('a'), push('b'), push('c')], context);

        expect(pushBlobs).toHaveBeenCalledOnce();
        expect(pushBlobs).toHaveBeenCalledWith([
            { id: 'a', hash: 'h-a' },
            { id: 'b', hash: 'h-b' },
            { id: 'c', hash: 'h-c' },
        ], expect.any(Function));
        expect(context.pushBlob).not.toHaveBeenCalled();
        expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
        expect(result.done).toBe(3);
    });

    it('รายงาน n/total ทีละชิ้นจนครบ', async () => {
        const seen: Array<[number, number]> = [];
        await applyOp([push('a'), push('b'), push('c')], ctx((p, t) => seen.push([p, t])));
        expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
    });

    // skip ไม่ได้อัปโหลดอะไร แต่ต้องนับ ไม่งั้นตัวเลขบน UI ค้างไม่ถึง total
    it('นับ skip ด้วย เพื่อให้เดินถึง total เสมอ', async () => {
        const seen: Array<[number, number]> = [];
        await applyOp([push('a'), skip('b'), push('c')], ctx((p, t) => seen.push([p, t])));
        expect(seen.map(([p]) => p)).toEqual([1, 2, 3]);
        expect(seen.at(-1)).toEqual([3, 3]);
    });

    it('ไม่ใส่ onProgress ก็ต้องไม่พัง', async () => {
        const c = ctx(undefined);
        await expect(applyOp([push('a')], c)).resolves.toBeDefined();
        expect(c.pushBlob).toHaveBeenCalledOnce();
    });
});
