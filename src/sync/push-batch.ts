import type { StorageAdapter } from '../backend/adapter';
import { uploadBlobsParallel } from '../backend/http';
import type { PushBlobItem } from '../sync-core/apply';

const PUSH_CONCURRENCY = 4;

export class MissingLocalBlobError extends Error {
    constructor(
        readonly itemId: string,
        readonly hash: string,
    ) {
        super(`Missing local blob for ${itemId} (${hash})`);
        this.name = 'MissingLocalBlobError';
    }
}

export interface UploadPushBatchOptions {
    readonly adapter: StorageAdapter;
    readonly items: readonly PushBlobItem[];
    readonly load: (hash: string) => Promise<Uint8Array | null>;
    readonly encrypt: (data: Uint8Array) => Promise<Uint8Array>;
    readonly onProcessed: (item: PushBlobItem) => void;
}

export interface PushHandlers {
    readonly pushBlob: (id: string, hash: string) => Promise<void>;
    readonly pushBlobs: (
        items: readonly PushBlobItem[],
        onProcessed: (item: PushBlobItem) => void,
    ) => Promise<void>;
}

export type PushHandlerDependencies = Pick<
    UploadPushBatchOptions,
    'adapter' | 'load' | 'encrypt'
>;

export function createPushHandlers(dependencies: PushHandlerDependencies): PushHandlers {
    const upload = (
        items: readonly PushBlobItem[],
        onProcessed: (item: PushBlobItem) => void,
    ) => uploadPushBatch({ ...dependencies, items, onProcessed });

    return {
        pushBlob: (id, hash) => upload([{ id, hash }], () => undefined),
        pushBlobs: upload,
    };
}

/** Load, encrypt, and upload each unique hash only when a worker is ready. */
export async function uploadPushBatch(options: UploadPushBatchOptions): Promise<void> {
    const itemsByHash = new Map<string, PushBlobItem[]>();
    for (const item of options.items) {
        const group = itemsByHash.get(item.hash);
        if (group) group.push(item);
        else itemsByHash.set(item.hash, [item]);
    }

    const getItems = (hash: string): readonly PushBlobItem[] => {
        const items = itemsByHash.get(hash);
        if (!items || items.length === 0) throw new TypeError(`Unknown push hash: ${hash}`);
        return items;
    };

    await uploadBlobsParallel(options.adapter, {
        hashes: [...itemsByHash.keys()],
        concurrency: PUSH_CONCURRENCY,
        load: async (hash) => {
            const item = getItems(hash)[0];
            const data = await options.load(hash);
            if (!data || data.byteLength === 0) throw new MissingLocalBlobError(item.id, hash);
            return options.encrypt(data);
        },
        onProcessed: (hash) => {
            for (const item of getItems(hash)) options.onProcessed(item);
        },
    });
}
