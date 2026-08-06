import type { Manifest } from '../sync-core/types';

export class ConflictError extends Error {
    constructor(message = 'Manifest version conflict') {
        super(message);
        this.name = 'ConflictError';
    }
}

/** Opaque storage-side revision. engine ห้ามตีความค่าข้างใน */
export type StorageRevision = string;

export type RemoteSnapshot =
    | { kind: 'single'; manifest: Manifest | null; revision: StorageRevision }
    | {
          kind: 'fork';
          heads: { commitId: string; manifest: Manifest }[];
          commonAncestor: Manifest | null;
          revision: StorageRevision;
      };

export interface StorageAdapter {
    getSnapshot(): Promise<RemoteSnapshot>;
    putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }>;
    checkBlobs(hashes: string[]): Promise<string[]>;
    getBlob(hash: string): Promise<Uint8Array>;
    putBlob(hash: string, data: Uint8Array): Promise<void>;
}
