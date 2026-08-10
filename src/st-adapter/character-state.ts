import type { SyncItem } from '../sync-core/types';
import { canonicalJson, sha256Hex } from './normalize';
import { stFetchJson } from './http';

type CharacterSummary = {
    readonly avatar?: string;
    readonly name?: string;
    readonly fav?: boolean | string;
    readonly data?: {
        readonly extensions?: {
            readonly fav?: boolean | string;
        };
    };
};

type FavoritePayload = {
    readonly fav: boolean;
};

function isFavorite(character: CharacterSummary): boolean {
    const value = character.data?.extensions?.fav ?? character.fav;
    return value === true || value === 'true';
}

export async function listCharacterStates(): Promise<Array<{ item: SyncItem; bytes: Uint8Array }>> {
    const characters = await stFetchJson<CharacterSummary[]>('/api/characters/all', {});
    const output: Array<{ item: SyncItem; bytes: Uint8Array }> = [];
    for (const character of Array.isArray(characters) ? characters : []) {
        if (!character.avatar) continue;
        const bytes = new TextEncoder().encode(canonicalJson({ fav: isFavorite(character) }));
        output.push({
            item: {
                id: `characterstate/${character.avatar}`,
                type: 'characterstate',
                hash: await sha256Hex(bytes),
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return output;
}

export async function writeCharacterState(avatar: string, payload: FavoritePayload): Promise<void> {
    await stFetchJson('/api/characters/merge-attributes', {
        avatar,
        fav: payload.fav,
        data: { extensions: { fav: payload.fav } },
    });
}
