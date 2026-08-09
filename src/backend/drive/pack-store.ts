import { sha256Hex } from '../../st-adapter/normalize';
import { DriveClient, type DriveFileMeta } from './client';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackLayout } from './pack-layout';
import { uploadPackResumable, type PackUploadControl } from './pack-uploader';
import type { DrivePackManifestV2, EncryptedPack } from './pack-types';
import {
    parentProperties,
    parseDriveV2Commit,
    type DriveV2CommitMeta,
} from './drive-v2-head';

export class DrivePackStore {
    private listing: Promise<Map<string, DriveFileMeta>> | null = null;
    private verifiedPacks: Map<string, number> | null = null;

    constructor(
        private readonly client: DriveClient,
        private readonly crypto: DrivePackCrypto,
        private readonly layout: DrivePackLayout,
    ) {}

    listPacks(): Promise<Map<string, DriveFileMeta>> {
        if (!this.listing) {
            this.listing = this.client.listChildren(this.layout.packsId)
                .then(files => new Map(files.map(file => [file.name, file])))
                .catch(error => {
                    this.listing = null;
                    throw error;
                });
        }
        return this.listing;
    }

    async hasCommittedSnapshot(): Promise<boolean> {
        const manifests = await this.client.listChildren(this.layout.manifestsId);
        return manifests.some(file => file.appProperties?.ts === 'commit-v2');
    }

    async listCommits(): Promise<DriveV2CommitMeta[]> {
        return (await this.client.listChildren(this.layout.manifestsId))
            .filter(file => file.appProperties?.ts === 'commit-v2')
            .map(parseDriveV2Commit);
    }

    async readManifest(commit: DriveV2CommitMeta): Promise<DrivePackManifestV2> {
        return this.crypto.decryptManifest(await this.client.getFileData(commit.fileId));
    }

    async readPack(name: string): Promise<Uint8Array> {
        const file = (await this.listPacks()).get(name);
        if (!file) throw new Error(`missing pack: ${name}`);
        return this.client.getFileData(file.id);
    }

    async putPack(pack: EncryptedPack, options: PackUploadControl = {}): Promise<void> {
        const packs = await this.listPacks();
        const existing = packs.get(pack.name);
        if (existing) {
            if (Number(existing.size) !== pack.bytes.byteLength) {
                throw new Error(`pack size mismatch for ${pack.name}: ${existing.size} != ${pack.bytes.byteLength}`);
            }
            return;
        }

        const file = await uploadPackResumable({
            client: this.client,
            parentId: this.layout.packsId,
            pack,
            ...options,
        });
        packs.set(pack.name, {
            ...file,
            size: file.size ?? String(pack.bytes.byteLength),
        });
        this.verifiedPacks = null;
    }

    async verifyPacks(expected: readonly { name: string; byteLength: number }[]): Promise<void> {
        const packs = await this.listPacks();
        const verified = new Map<string, number>();
        for (const pack of expected) {
            const file = packs.get(pack.name);
            if (!file) throw new Error(`missing pack: ${pack.name}`);
            if (Number(file.size) !== pack.byteLength) {
                throw new Error(`pack size mismatch for ${pack.name}: ${file.size} != ${pack.byteLength}`);
            }
            verified.set(pack.name, pack.byteLength);
        }
        this.verifiedPacks = verified;
    }

    async commitManifest(
        manifest: DrivePackManifestV2,
        parents: readonly string[] = [],
    ): Promise<{ commitId: string }> {
        if (!this.verifiedPacks) throw new Error('packs must be verified before manifest commit');
        for (const item of Object.values(manifest.items)) {
            for (const chunk of item.chunks) {
                if (!this.verifiedPacks.has(chunk.packName)) {
                    throw new Error(`manifest references unverified pack: ${chunk.packName}`);
                }
            }
        }

        const bytes = await this.crypto.encryptManifest(manifest);
        const commitId = await sha256Hex(bytes);
        await this.client.createFile(
            this.layout.manifestsId,
            `${commitId}.enc`,
            bytes,
            { ts: 'commit-v2', ...parentProperties(parents) },
        );
        return { commitId };
    }
}
