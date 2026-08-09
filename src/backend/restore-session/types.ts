export type RestoreItemType =
    | 'settings' | 'preset' | 'worldinfo' | 'persona' | 'character'
    | 'chat' | 'group' | 'groupchat' | 'quickreply' | 'theme';

export interface RestoreCapabilities {
    readonly protocol: 1;
    readonly maxSegmentBytes: 1_048_576;
    readonly maxBatchBytes: 8_388_608;
    readonly maxBatchSegments: 8;
    readonly maxInFlightBatches: 2;
    readonly itemTypes: readonly RestoreItemType[];
    readonly supportsRollback: boolean;
    readonly supportsCancellation: boolean;
}

export interface RestoreStartItem {
    readonly id: string;
    readonly type: RestoreItemType;
    readonly size: number;
    readonly hash: string;
    readonly segmentCount: number;
}

export interface RestoreStartRequest {
    readonly requestId: string;
    readonly snapshotId: string;
    readonly scopes: readonly RestoreItemType[];
    readonly expectedItems: number;
    readonly expectedBytes: number;
    readonly items: readonly RestoreStartItem[];
}

export type RestoreSessionState =
    | 'receiving' | 'ready' | 'applying' | 'deleting' | 'rolling_back'
    | 'committed' | 'cancelled' | 'failed' | 'rolled_back';

export interface RestoreSessionStatus {
    readonly sessionId: string;
    readonly snapshotId: string;
    readonly state: RestoreSessionState;
    readonly receivedSegments?: number;
    readonly expectedSegments?: number;
    readonly receivedItems?: number;
    readonly expectedItems?: number;
    readonly receivedBytes?: number;
    readonly expectedBytes?: number;
}

export interface RestoreCommittedResult extends RestoreSessionStatus {
    readonly state: 'committed';
    readonly metrics?: Readonly<Record<string, number>>;
}
