import type { ApplyOp } from './types';
import { sortPullOps } from './plan';
import { mapPool } from '../util/pool';

const PULL_CONCURRENCY = 4;

export interface PushBlobItem {
    readonly id: string;
    readonly hash: string;
}

export type PreparedPull = () => Promise<void>;

export interface ApplyContext {
    dryRun: boolean;
    log: (msg: string, meta?: unknown) => void;
    pushBlob: (id: string, hash: string) => Promise<void>;
    pushBlobs?: (
        items: readonly PushBlobItem[],
        onProcessed: (item: PushBlobItem) => void,
    ) => Promise<void>;
    /** Prepare network/crypto work in parallel; returned ST writer is applied serially. */
    preparePull?: (id: string, type: ApplyOp['type'], hash: string) => Promise<PreparedPull>;
    pullAndApply: (id: string, type: ApplyOp['type'], hash: string) => Promise<void>;
    keepBoth: (id: string, type: ApplyOp['type']) => Promise<void>;
    tombstone: (id: string) => Promise<void>;
    /** ยิงหลังจบแต่ละ op — ใช้โชว์ n/total บน UI
     *  อย่าเขียน console ใน callback นี้ แผนใหญ่ ๆ มีหลักพัน op จะท่วมคอนโซล */
    onProgress?: (processed: number, total: number) => void;
}

/**
 * Execute plan. Every destructive path goes through here.
 * Logs the full plan before executing.
 */
export async function applyOp(ops: ApplyOp[], ctx: ApplyContext): Promise<{ done: number; skipped: number; failed: string[] }> {
    ctx.log('Plan', ops);
    const pullOps = sortPullOps(ops.filter((o) => o.kind === 'pull_blob' || o.kind === 'keep_both'));
    const pushOps = ops.filter((o) => o.kind === 'push_blob');
    const other = ops.filter((o) => o.kind !== 'pull_blob' && o.kind !== 'keep_both' && o.kind !== 'push_blob');

    let done = 0;
    let skipped = 0;
    const failed: string[] = [];

    const run = async (op: ApplyOp) => {
        try {
            if (op.kind === 'skip') {
                skipped++;
                ctx.log('skip', op);
                return;
            }
            if (ctx.dryRun || op.dryRun) {
                ctx.log('dry-run', op);
                done++;
                return;
            }
            switch (op.kind) {
                case 'push_blob':
                    await ctx.pushBlob(op.id, op.hash!);
                    break;
                case 'pull_blob':
                    await ctx.pullAndApply(op.id, op.type, op.hash!);
                    break;
                case 'keep_both':
                    await ctx.keepBoth(op.id, op.type);
                    break;
                case 'tombstone':
                    await ctx.tombstone(op.id);
                    break;
                case 'apply_local':
                    await ctx.pullAndApply(op.id, op.type, op.hash!);
                    break;
            }
            done++;
        } catch (e) {
            failed.push(op.id);
            ctx.log('failed', { op, error: String(e) });
            throw e;
        }
    };

    // นับรวมทุก op (รวม skip) เพื่อให้ตัวเลขบน UI เดินถึง total เสมอ
    const total = ops.length;
    let processed = 0;
    const reportProgress = () => ctx.onProgress?.(++processed, total);
    const step = async (op: ApplyOp) => {
        await run(op);
        reportProgress();
    };
    const prepare = async (op: ApplyOp): Promise<PreparedPull> => {
        try {
            return await ctx.preparePull!(op.id, op.type, op.hash!);
        } catch (error) {
            failed.push(op.id);
            ctx.log('failed', { op, error: String(error) });
            throw error;
        }
    };
    const applyPrepared = async (op: ApplyOp, prepared: PreparedPull) => {
        try {
            await prepared();
            done++;
            reportProgress();
        } catch (error) {
            failed.push(op.id);
            ctx.log('failed', { op, error: String(error) });
            throw error;
        }
    };

    // Push first (upload), then pulls in dependency order, then other
    const canBatchPush = !!ctx.pushBlobs && !ctx.dryRun && pushOps.every((op) => !op.dryRun);
    if (canBatchPush && ctx.pushBlobs) {
        const items = pushOps.map((op) => {
            if (!op.hash) throw new TypeError(`push_blob ${op.id} has no hash`);
            return { id: op.id, hash: op.hash };
        });
        const completed = new Set<string>();
        try {
            await ctx.pushBlobs(items, (item) => {
                completed.add(item.id);
                done++;
                ctx.log('push_blob', item);
                reportProgress();
            });
        } catch (error) {
            for (const op of pushOps) {
                if (!completed.has(op.id)) failed.push(op.id);
            }
            ctx.log('failed', { ops: pushOps, error: String(error) });
            throw error;
        }
    } else {
        for (const op of pushOps) await step(op);
    }
    // Type groups retain ordering constraints (for example settings before personas).
    // Production Pull prepares only network/crypto work four-wide, then applies each
    // result serially so ST never parses/imports multiple large payloads at once.
    for (let start = 0; start < pullOps.length;) {
        const type = pullOps[start].type;
        let end = start + 1;
        while (end < pullOps.length && pullOps[end].type === type) end++;
        const group = pullOps.slice(start, end);
        if (ctx.preparePull && !ctx.dryRun) {
            let batch: ApplyOp[] = [];
            const flush = async () => {
                if (batch.length === 0) return;
                const current = batch;
                batch = [];
                const prepared = await mapPool(current, PULL_CONCURRENCY, prepare);
                for (let index = 0; index < current.length; index++) {
                    await applyPrepared(current[index], prepared[index]);
                }
            };

            for (const op of group) {
                if (op.kind === 'pull_blob' && !op.dryRun) {
                    batch.push(op);
                    if (batch.length === PULL_CONCURRENCY) await flush();
                } else {
                    await flush();
                    await step(op);
                }
            }
            await flush();
        } else {
            for (const op of group) await step(op);
        }
        start = end;
    }
    for (const op of other) await step(op);

    return { done, skipped, failed };
}
