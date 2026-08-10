import type { SyncItem } from '../sync-core/types';
import { EXTENSION_FOLDER } from '../settings';
import { stFetchJson } from './http';
import { canonicalJson, sha256Hex } from './normalize';

export type ExtensionDescriptor = {
    readonly name: string;
    readonly url: string;
    readonly global: boolean;
};

type DiscoveredExtension = {
    readonly type: 'system' | 'local' | 'global';
    readonly name: string;
};

type ExtensionVersion = {
    readonly remoteUrl?: string;
};

const SELF_EXTENSION_NAME = EXTENSION_FOLDER.replace(/^third-party\//, '');

function isInstalled(discovered: readonly DiscoveredExtension[], name: string): boolean {
    return discovered.some(extension => extension.name === `third-party/${name}`);
}

async function discoverExtensions(): Promise<DiscoveredExtension[]> {
    const response = await fetch('/api/extensions/discover', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Extension discovery failed: ${response.status}`);
    return await response.json() as DiscoveredExtension[];
}

export async function listExtensionStates(): Promise<Array<{ item: SyncItem; bytes: Uint8Array }>> {
    const discovered = await discoverExtensions();
    const output: Array<{ item: SyncItem; bytes: Uint8Array }> = [];
    for (const extension of discovered) {
        if (!extension.name.startsWith('third-party/')) continue;
        const name = extension.name.slice('third-party/'.length);
        if (name === SELF_EXTENSION_NAME) continue;
        const global = extension.type === 'global';
        const version = await stFetchJson<ExtensionVersion>('/api/extensions/version', {
            extensionName: name,
            global,
        });
        if (!version.remoteUrl) continue;
        const descriptor: ExtensionDescriptor = { name, url: version.remoteUrl, global };
        const bytes = new TextEncoder().encode(canonicalJson(descriptor));
        output.push({
            item: {
                id: `extension/${name}`,
                type: 'extension',
                hash: await sha256Hex(bytes),
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return output;
}

export async function installExtension(descriptor: ExtensionDescriptor): Promise<void> {
    if (descriptor.name === SELF_EXTENSION_NAME) return;
    if (isInstalled(await discoverExtensions(), descriptor.name)) return;
    await stFetchJson('/api/extensions/install', {
        url: descriptor.url,
        global: descriptor.global,
    });
}
