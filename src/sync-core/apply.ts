import type { ApplyOp } from './types';
import { sortPullOps } from './plan';

export interface ApplyContext {
    dryRun: boolean;
    log: (msg: string, meta?: unknown) => void;
    pushBlob: (id: string, hash: string) => Promise<void>;
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
    const step = async (op: ApplyOp) => {
        await run(op);
        ctx.onProgress?.(++processed, total);
    };

    // Push first (upload), then pulls in dependency order, then other
    for (const op of pushOps) await step(op);
    for (const op of pullOps) await step(op);
    for (const op of other) await step(op);

    return { done, skipped, failed };
}
