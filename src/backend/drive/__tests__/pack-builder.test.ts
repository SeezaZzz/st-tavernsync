import { describe, expect, it } from 'vitest';

import type { SyncItem } from '../../../sync-core/types';
import { MissingLocalBlobError } from '../../../sync/push-batch';
import { buildDrivePacks, type BuildDrivePacksOptions } from '../pack-builder';
import type { DrivePackCrypto } from '../pack-crypto';
import type { DrivePackManifestV2, EncryptedPack } from '../pack-types';

function item(id: string, size: number): SyncItem {
    return { id, type: 'character', hash: `hash-${id}`, size, mtime: 123 };
}

const fixtures: Record<string, Uint8Array> = {};

function deterministicCryptoStub(): DrivePackCrypto {
    return {
        async encryptChunk(plain) {
            const boxed = new Uint8Array(plain.byteLength + 1);
            boxed[0] = 0xee;
            boxed.set(plain, 1);
            return boxed;
        },
        async decryptChunk(boxed) {
            return boxed.slice(1);
        },
        async packName(entries) {
            return `pack-${entries.map(entry => `${entry.chunkHash}:${entry.plainLength}`).join('|')}`;
        },
        async encryptManifest() {
            throw new Error('not used');
        },
        async decryptManifest() {
            throw new Error('not used');
        },
    };
}

interface BuildFixtureResult {
    emitted: EncryptedPack[];
    manifest: DrivePackManifestV2;
}

async function buildFixture(
    size: number,
    limits: { chunkBytes: number; packBytes: number },
): Promise<BuildFixtureResult> {
    const source = new Uint8Array(size).fill(9);
    fixtures['hash-a'] = source;
    const emitted: EncryptedPack[] = [];
    const manifest = await buildDrivePacks({
        device: 'pc',
        items: [item('a', size)],
        ...limits,
        load: async hash => fixtures[hash] ?? null,
        crypto: deterministicCryptoStub(),
        emit: async pack => { emitted.push(pack); },
    });
    return { emitted, manifest };
}

function reassembleFixture(result: BuildFixtureResult): Uint8Array {
    const packs = new Map(result.emitted.map(pack => [pack.name, pack.bytes]));
    const parts = result.manifest.items.a.chunks.map(ref => {
        const pack = packs.get(ref.packName);
        if (!pack) throw new Error(`missing ${ref.packName}`);
        return pack.slice(ref.offset + 1, ref.offset + ref.boxedLength);
    });
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
    }
    return joined;
}

function baseOptions(): BuildDrivePacksOptions {
    fixtures['hash-a'] = new Uint8Array([9]);
    return {
        device: 'pc',
        items: [item('a', 1)],
        chunkBytes: 4,
        packBytes: 10,
        load: async hash => fixtures[hash] ?? null,
        crypto: deterministicCryptoStub(),
        emit: async () => undefined,
    };
}

describe('Drive pack builder', () => {
    it('sorts items, chunks once, and emits bounded packs', async () => {
        const emitted: EncryptedPack[] = [];
        const loaded: string[] = [];
        fixtures['hash-a'] = new Uint8Array(6).fill(9);
        fixtures['hash-b'] = new Uint8Array(1).fill(9);
        const manifest = await buildDrivePacks({
            device: 'pc',
            items: [item('b', 1), item('a', 6)],
            chunkBytes: 4,
            packBytes: 10,
            load: async hash => { loaded.push(hash); return fixtures[hash] ?? null; },
            crypto: deterministicCryptoStub(),
            emit: async pack => { emitted.push(pack); },
        });
        expect(loaded).toEqual(['hash-a', 'hash-b']);
        expect(emitted.every(pack => pack.bytes.byteLength <= 10)).toBe(true);
        expect(Object.keys(manifest.items)).toEqual(['a', 'b']);
        expect(manifest.items.a.chunks).toHaveLength(2);
        expect(manifest.items.a.chunks.at(-1)?.packName).toBe(manifest.items.b.chunks[0].packName);
    });

    it.each([0, 1, 4, 5, 8])('round-trips boundary size %i', async size => {
        const result = await buildFixture(size, { chunkBytes: 4, packBytes: 10 });
        expect(reassembleFixture(result)).toEqual(new Uint8Array(size).fill(9));
    });

    it('fails before emit when a source blob is missing', async () => {
        await expect(buildDrivePacks({ ...baseOptions(), load: async () => null }))
            .rejects.toBeInstanceOf(MissingLocalBlobError);
    });
});
