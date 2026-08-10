import type { ItemType } from '../../../sync-core/types';
import { sha256Hex } from '../../../st-adapter/normalize';
import type { DriveV2PullOptions } from '../drive-v2-pull';
import { DriveV2PullCheckpoint, type DriveV2PullCheckpointState } from '../pull-checkpoint';

export interface AdaptivePullHarnessInput {
    remote: string[];
    local?: string[];
    completed?: string[];
    fail?: string;
    fault?: 'network-loss' | 'http-408' | 'http-429' | 'http-500' | 'wrong-passphrase'
        | 'chunk-hash' | 'item-hash' | 'apply-failure' | 'cancel';
}

export interface AdaptivePullHarness {
    options: DriveV2PullOptions;
    events: string[];
    deletedIds: string[];
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
    const items = Object.fromEntries(input.remote.map((id, index) => [id, {
        id,
        type: typeOf(id),
        hash: input.fault === 'item-hash' && index === 0 ? '0'.repeat(64) : hash,
        size: 1,
        mtime: 1,
        chunks: [{
            packName: 'pack',
            offset: index,
            boxedLength: 1,
            plainLength: 1,
            chunkHash: hash,
        }],
    }]));
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
    let firstRead = true;

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
        allowedTypes: new Set(Object.values(items).map(item => item.type)),
        checkpoint,
        source: {
            readChunk: async ref => {
                const item = Object.values(items)
                    .find(value => value.chunks[0].offset === ref.offset)!;
                events.push(`read:${item.id}`);
                if (firstRead && input.fault
                    && ['network-loss', 'http-408', 'http-429', 'http-500'].includes(input.fault)) {
                    firstRead = false;
                    throw new Error(input.fault);
                }
                if (input.fault === 'chunk-hash') return new Uint8Array([2]);
                return bytes.slice();
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
        get savedBase() { return savedBase; },
        get checkpointState() { return checkpointState; },
        inventory: () => [...currentInventory.keys()].sort(),
        remoteInventory: () => [...input.remote].sort(),
    };
}
