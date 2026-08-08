import { describe, expect, it, vi } from 'vitest';
import { applyOp } from '../apply';
import type { ApplyOp, ItemType } from '../types';

const pull = (id: string, type: ItemType): ApplyOp => ({
    id,
    kind: 'pull_blob',
    type,
    hash: `hash-${id}`,
});

function context(pullAndApply: (id: string, type: ItemType, hash: string) => Promise<void>) {
    return {
        dryRun: false,
        log: vi.fn(),
        pushBlob: vi.fn(async () => {}),
        pullAndApply,
        keepBoth: vi.fn(async () => {}),
        tombstone: vi.fn(async () => {}),
    };
}

describe('applyOp pull concurrency', () => {
    it('prepares four pulls concurrently but applies them one at a time', async () => {
        let activePrepare = 0;
        let peakPrepare = 0;
        let activeApply = 0;
        let peakApply = 0;
        const preparePull = vi.fn(async () => {
            activePrepare++;
            peakPrepare = Math.max(peakPrepare, activePrepare);
            await new Promise((resolve) => setTimeout(resolve, 5));
            activePrepare--;
            return async () => {
                activeApply++;
                peakApply = Math.max(peakApply, activeApply);
                await new Promise((resolve) => setTimeout(resolve, 5));
                activeApply--;
            };
        });
        const legacyPullAndApply = vi.fn(async () => {
            throw new Error('legacy pull path must not run');
        });
        const ops = Array.from({ length: 8 }, (_, index) => pull(`chat-${index}`, 'chat'));

        await applyOp(ops, {
            ...context(legacyPullAndApply),
            preparePull,
        });

        expect(peakPrepare).toBe(4);
        expect(peakApply).toBe(1);
        expect(preparePull).toHaveBeenCalledTimes(8);
        expect(legacyPullAndApply).not.toHaveBeenCalled();
    });

    it('applies each prepared batch before preparing the next batch', async () => {
        const events: string[] = [];
        const preparePull = vi.fn(async (id: string) => {
            events.push(`prepare:${id}`);
            return async () => {
                events.push(`apply:${id}`);
            };
        });
        const ops = Array.from({ length: 8 }, (_, index) => pull(`chat-${index}`, 'chat'));

        await applyOp(ops, {
            ...context(vi.fn(async () => {})),
            preparePull,
        });

        expect(events.indexOf('apply:chat-3')).toBeLessThan(events.indexOf('prepare:chat-4'));
    });

    it('does not overlap keep_both writes with prepared pull writes', async () => {
        let activeWrites = 0;
        let peakWrites = 0;
        const write = async () => {
            activeWrites++;
            peakWrites = Math.max(peakWrites, activeWrites);
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeWrites--;
        };
        const pullOp = pull('chat-pull', 'chat');
        const keepBothOp: ApplyOp = { id: 'chat-both', kind: 'keep_both', type: 'chat' };

        await applyOp([pullOp, keepBothOp], {
            ...context(write),
            preparePull: async () => write,
            keepBoth: vi.fn(write),
        });

        expect(peakWrites).toBe(1);
    });

    it('falls back to serial pull when preparePull is unavailable', async () => {
        let active = 0;
        let peak = 0;
        const pullAndApply = vi.fn(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
        });
        const ops = Array.from({ length: 8 }, (_, index) => pull(`chat-${index}`, 'chat'));

        await applyOp(ops, context(pullAndApply));

        expect(peak).toBe(1);
    });

    it('finishes one item type before starting the next type', async () => {
        const activeTypes = new Set<ItemType>();
        let crossedTypeBarrier = false;
        const events: string[] = [];
        const pullAndApply = vi.fn(async (id: string, type: ItemType) => {
            activeTypes.add(type);
            if (activeTypes.size > 1) crossedTypeBarrier = true;
            events.push(`start:${id}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            events.push(`end:${id}`);
            activeTypes.delete(type);
        });
        const ops = [
            pull('preset-1', 'preset'),
            pull('world-1', 'worldinfo'),
            pull('preset-2', 'preset'),
            pull('world-2', 'worldinfo'),
        ];

        await applyOp(ops, context(pullAndApply));

        expect(crossedTypeBarrier).toBe(false);
        expect(events.indexOf('start:preset-1')).toBeGreaterThan(events.indexOf('end:world-2'));
    });

    it('does not start a later item type after the current group fails', async () => {
        const started: string[] = [];
        const pullAndApply = vi.fn(async (id: string) => {
            started.push(id);
            if (id === 'world-bad') throw new Error('download failed');
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        const ops = [
            pull('world-bad', 'worldinfo'),
            pull('world-peer', 'worldinfo'),
            pull('preset-never', 'preset'),
        ];

        await expect(applyOp(ops, context(pullAndApply))).rejects.toThrow('download failed');

        expect(started).not.toContain('preset-never');
    });
});
