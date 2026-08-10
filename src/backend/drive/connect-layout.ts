import type { DriveLayout } from './adapter';
import type { DriveClient, DriveFileMeta } from './client';
import {
    listExistingDrivePackLayouts,
    type DrivePackLayout,
} from './pack-layout';

export type ConnectedDriveLayout =
    | { version: 1; layout: DriveLayout }
    | { version: 2; layout: DrivePackLayout | null };

export async function resolveDriveLayoutForConnect(options: {
    client: DriveClient;
    currentVersion: 1 | 2;
    knownRootId: string;
    pickLegacyRoot(roots: DriveFileMeta[]): Promise<string | null>;
}): Promise<ConnectedDriveLayout> {
    const knownRootId = options.knownRootId.trim();
    const layouts = await listExistingDrivePackLayouts(options.client);
    const remembered = layouts.find(layout => layout.rootId === knownRootId);
    if (options.currentVersion === 2 && remembered) {
        return { version: 2, layout: remembered };
    }
    return { version: 2, layout: null };
}
