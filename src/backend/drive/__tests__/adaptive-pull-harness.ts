import type { ItemType } from '../../../sync-core/types';
import { sha256Hex } from '../../../st-adapter/normalize';
import type { DriveV2PullOptions } from '../drive-v2-pull';
import { DriveV2PullCheckpoint, type DriveV2PullCheckpointState } from '../pull-checkpoint';

export interface AdaptivePullHarnessInput {
    remote: string[];
    local?: string[];
    inSync?: string[];
    completed?: string[];
    fail?: string;
    packCount?: number;
    packNames?: string[];
    packReadDelayMs?: number;
    fault?: 'network-loss' | 'http-408' | 'http-429' | 'http-500' | 'wrong-passphrase'
        | 'chunk-hash' | 'item-hash' | 'apply-failure' | 'cancel';
}

export interface AdaptivePullHarness {
    options: DriveV2PullOptions;
    events: string[];
    deletedIds: string[];
    readonly packReads: number;
    readonly chunkReads: number;
    readonly savedBase: string | null;
    readonly checkpointState: DriveV2PullCheckpointState | null;
    inventory(): string[];
    remoteInventory(): string[];
}

function typeOf(id: string): ItemType {
    return id.split('/')[0] as ItemType;
}

export async function createAdaptivePullHarness(
    input: AdaptivePullHarnessInput,
): Promise<AdaptivePullHarness> {
    const events: string[] = [];
    const deletedIds: string[] = [];
    const currentInventory = new Map((input.local ?? []).map(id => [id, typeOf(id)]));
    let savedBase: string | null = null;
    let checkpointState: DriveV2PullCheckpointState | null = {
        commitId: 'head-b',
        completedItemIds: input.completed ?? [],
        updatedAt: 1,
    };
    const bytes = new Uint8Array([1]);
    const hash = await sha256Hex(bytes);
    const packCount = Math.max(1, Math.min(input.packCount ?? 1, input.remote.length || 1));
    const itemsPerPack = Math.max(1, Math.ceil(input.remote.length / packCount));
    const nextOffset = new Map<string, number>();
    const packSizes = new Map<string, number>();
    const items = Object.fromEntries(input.remote.map((id, index) => {
        const packName = input.packNames?.[index]
            ?? `pack-${Math.floor(index / itemsPerPack)}`;
        const offset = nextOffset.get(packName) ?? 0;
        nextOffset.set(packName, offset + 1);
        packSizes.set(packName, offset + 1);
        return [id, {
            id,
            type: typeOf(id),
            hash: input.fault === 'item-hash' && index === 0 ? '0'.repeat(64) : hash,
            size: 1,
            mtime: 1,
            chunks: [{
                packName,
                offset,
                boxedLength: 1,
                plainLength: 1,
                chunkHash: hash,
            }],
        }];
    }));
    const checkpoint = new DriveV2PullCheckpoint('head-b', {
        load: () => checkpointState,
        save: value => {
            checkpointState = value;
            events.push(value ? 'checkpoint-flush' : 'checkpoint-finish');
        },
    });
    const abort = new AbortController();
    if (input.fault === 'cancel') {
        abort.abort(new DOMException('cancelled', 'AbortError'));
    }
    let packReads = 0;
    let chunkReads = 0;

    const options: DriveV2PullOptions = {
        commit: {
            fileId: 'file-b',
            commitId: 'head-b',
            parents: [],
            createdTime: '2026-08-10T00:00:00Z',
        },
        manifest: {
            schema: 2,
            storage: 'drive-pack-v2',
            device: 'pc',
            updatedAt: 1,
            chunkBytes: 1,
            packBytes: 32,
            items,
        },
        localInventory: currentInventory,
        localHashes: new Map((input.inSync ?? []).map(id => [id, hash])),
        allowedTypes: new Set(Object.values(items).map(item => item.type)),
        checkpoint,
        source: {
            readPack: async name => {
                packReads += 1;
                if (input.packReadDelayMs) {
                    await new Promise(resolve => setTimeout(resolve, input.packReadDelayMs));
                }
                if (input.fault
                    && ['network-loss', 'http-408', 'http-429', 'http-500'].includes(input.fault)) {
                    throw new Error(input.fault);
                }
                return new Uint8Array(packSizes.get(name) ?? 0)
                    .fill(input.fault === 'chunk-hash' ? 2 : 1);
            },
            readChunk: async ref => {
                chunkReads += 1;
                if (input.fault
                    && ['network-loss', 'http-408', 'http-429', 'http-500'].includes(input.fault)) {
                    throw new Error(input.fault);
                }
                return new Uint8Array(ref.boxedLength)
                    .fill(input.fault === 'chunk-hash' ? 2 : 1);
            },
        },
        crypto: {
            decryptChunk: async value => {
                if (input.fault === 'wrong-passphrase') {
                    throw new DOMException('authentication failed', 'OperationError');
                }
                return value;
            },
        },
        applyItem: async (id, type) => {
            events.push(`apply:${id}`);
            if (id === input.fail || input.fault === 'apply-failure') throw new Error(id);
            currentInventory.set(id, type);
        },
        deleteItem: async id => {
            events.push(`delete:${id}`);
            deletedIds.push(id);
            currentInventory.delete(id);
        },
        saveBase: async id => {
            events.push(`save-base:${id}`);
            savedBase = id;
        },
        signal: abort.signal,
    };

    return {
        options,
        events,
        deletedIds,
        get packReads() { return packReads; },
        get chunkReads() { return chunkReads; },
        get savedBase() { return savedBase; },
        get checkpointState() { return checkpointState; },
        inventory: () => [...currentInventory.keys()].sort(),
        remoteInventory: () => [...input.remote].sort(),
    };
}
