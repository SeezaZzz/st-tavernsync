import { clearBackendState as clearStoredBackendState } from '../../state/store';
import { DriveClient, type DriveFileMeta } from './client';

export interface DrivePackLayout {
    rootId: string;
    packsId: string;
    manifestsId: string;
}

export interface ResetDriveRootToV2Options {
    client: DriveClient;
    oldRootId: string;
    oldNamespace: string;
    clearBackendState?(namespace: string): Promise<void>;
}

export class MultipleDrivePackRootsError extends Error {
    constructor(readonly roots: DriveFileMeta[]) {
        super('Multiple TavernSync v2 root folders found');
        this.name = 'MultipleDrivePackRootsError';
    }
}

function layoutFromChildren(rootId: string, children: readonly DriveFileMeta[]): DrivePackLayout {
    const packs = children.find(child => child.name === 'packs');
    const manifests = children.find(child => child.name === 'manifests');
    if (!packs || !manifests) {
        throw new Error('TavernSync v2 root is incomplete (missing packs/ or manifests/)');
    }
    return { rootId, packsId: packs.id, manifestsId: manifests.id };
}

export async function createDrivePackLayout(client: DriveClient): Promise<DrivePackLayout> {
    const root = await client.createFolder('TavernSync', { ts: 'root-v2' });
    const packs = await client.createFolder('packs', {}, root.id);
    const manifests = await client.createFolder('manifests', {}, root.id);
    return { rootId: root.id, packsId: packs.id, manifestsId: manifests.id };
}

export async function discoverDrivePackLayout(
    client: DriveClient,
    knownRootId?: string,
): Promise<DrivePackLayout> {
    if (knownRootId) {
        return layoutFromChildren(knownRootId, await client.listChildren(knownRootId));
    }
    const roots = await client.searchRootFolders('root-v2');
    if (roots.length > 1) throw new MultipleDrivePackRootsError(roots);
    if (roots.length === 0) return createDrivePackLayout(client);
    return layoutFromChildren(roots[0].id, await client.listChildren(roots[0].id));
}

export async function resetDriveRootToV2(options: ResetDriveRootToV2Options): Promise<DrivePackLayout> {
    if (!options.oldRootId.trim()) throw new TypeError('oldRootId is required');
    const layout = await createDrivePackLayout(options.client);
    await options.client.trashFile(options.oldRootId);
    await (options.clearBackendState ?? clearStoredBackendState)(options.oldNamespace);
    return layout;
}
