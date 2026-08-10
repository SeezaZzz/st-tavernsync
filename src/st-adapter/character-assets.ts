import type { ItemType, SyncItem } from '../sync-core/types';
import { mapPool } from '../util/pool';
import { stFetchBytes, stFetchJson } from './http';
import { sha256Hex } from './normalize';

export interface CharacterAssetApi {
    getJson<T>(url: string): Promise<T>;
    postJson<T>(url: string): Promise<T>;
    getBytes(url: string): Promise<Uint8Array>;
}

export interface CharacterAssetRef {
    id: string;
    type: Extract<ItemType, 'characterasset'>;
}

interface DiscoveredCharacterAsset extends CharacterAssetRef {
    sourceUrl: string;
}

const defaultApi: CharacterAssetApi = {
    async getJson<T>(url: string): Promise<T> {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
        return response.json() as Promise<T>;
    },
    postJson: (url) => stFetchJson(url, {}),
    getBytes: url => stFetchBytes(url),
};

function encodePathComponent(value: string): string {
    if (!value || value === '.' || value === '..') {
        throw new Error(`Invalid character asset path component: ${value}`);
    }
    return encodeURIComponent(value);
}

export function characterAssetId(characterName: string, relativePath: string): string {
    const pathParts = relativePath.split('/').map(encodePathComponent);
    return ['characterasset', encodePathComponent(characterName), ...pathParts].join('/');
}

export function decodeCharacterAssetId(id: string): {
    characterName: string;
    relativePath: string;
} {
    const [type, encodedCharacter, ...encodedPath] = id.split('/');
    if (type !== 'characterasset' || !encodedCharacter || encodedPath.length === 0) {
        throw new Error(`Invalid character asset id: ${id}`);
    }
    const characterName = decodeURIComponent(encodedCharacter);
    const pathParts = encodedPath.map(part => decodeURIComponent(part));
    for (const part of [characterName, ...pathParts]) encodePathComponent(part);
    return { characterName, relativePath: pathParts.join('/') };
}

function relativeAssetPath(sourceUrl: string): string {
    const pathname = new URL(sourceUrl, 'http://tavernsync.local').pathname;
    const parts = pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    const charactersIndex = parts.indexOf('characters');
    if (charactersIndex < 0 || parts.length < charactersIndex + 3) {
        throw new Error(`Unsupported character asset URL: ${sourceUrl}`);
    }
    return parts.slice(charactersIndex + 2).join('/');
}

async function discoverCharacterAssets(
    characterName: string,
    api: CharacterAssetApi,
): Promise<DiscoveredCharacterAsset[]> {
    const encodedName = encodeURIComponent(characterName);
    const [sprites, bgm] = await Promise.all([
        api.getJson<Array<{ path?: string }>>(`/api/sprites/get?name=${encodedName}`),
        api.postJson<string[]>(`/api/assets/character?name=${encodedName}&category=bgm`),
    ]);
    const urls = [
        ...(Array.isArray(sprites) ? sprites.map(sprite => sprite.path).filter(Boolean) : []),
        ...(Array.isArray(bgm) ? bgm : []),
    ] as string[];
    const unique = new Map<string, DiscoveredCharacterAsset>();
    for (const sourceUrl of urls) {
        const relativePath = relativeAssetPath(sourceUrl);
        const id = characterAssetId(characterName, relativePath);
        unique.set(id, { id, type: 'characterasset', sourceUrl });
    }
    return [...unique.values()];
}

export async function listCharacterAssetRefs(
    characterName: string,
    api: CharacterAssetApi = defaultApi,
): Promise<CharacterAssetRef[]> {
    return (await discoverCharacterAssets(characterName, api))
        .map(({ id, type }) => ({ id, type }));
}

export async function listCharacterAssets(
    characterName: string,
    api: CharacterAssetApi = defaultApi,
): Promise<Array<{ item: SyncItem; bytes: Uint8Array }>> {
    const assets = await discoverCharacterAssets(characterName, api);
    return mapPool(assets, 4, async asset => {
        const bytes = await api.getBytes(asset.sourceUrl);
        return {
            bytes,
            item: {
                id: asset.id,
                type: asset.type,
                hash: await sha256Hex(bytes),
                size: bytes.byteLength,
                mtime: Date.now(),
            },
        };
    });
}
