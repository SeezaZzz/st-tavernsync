/** Drive backend crypto: HKDF subkeys + folderId-derived PBKDF2 salt. */

const encoder = new TextEncoder();

/** Salt ของ Drive backend — derive จาก folderId (ไม่ใช่ความลับ แต่ต้อง deterministic ทุกเครื่อง) */
export async function driveSaltFromFolderIdAsync(folderId: string): Promise<Uint8Array> {
    const d = await crypto.subtle.digest('SHA-256', encoder.encode(`TavernSync/account-salt/v1:${folderId}`));
    return new Uint8Array(d).slice(0, 16);
}

export interface DriveSubkeys {
    manifestEnc: CryptoKey;
    blobEnc: CryptoKey;
    blobName: CryptoKey;
}

export interface DrivePackSubkeys {
    chunkEnc: CryptoKey;
    packName: CryptoKey;
    manifestEnc: CryptoKey;
}

async function hkdf(rootRaw: Uint8Array, folderId: string, info: string, keyType: 'aes' | 'hmac'): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', rootRaw as BufferSource, 'HKDF', false, ['deriveKey']);
    const salt = encoder.encode(`TavernSync/hkdf-salt/v1:${folderId}`);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: encoder.encode(info) as BufferSource },
        base,
        keyType === 'aes' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256' },
        false,
        keyType === 'aes' ? ['encrypt', 'decrypt'] : ['sign'],
    );
}

export function deriveDriveSubkeys(rootKeyRaw: Uint8Array, folderId: string): Promise<DriveSubkeys> {
    return Promise.all([
        hkdf(rootKeyRaw, folderId, 'manifest-enc', 'aes'),
        hkdf(rootKeyRaw, folderId, 'blob-enc', 'aes'),
        hkdf(rootKeyRaw, folderId, 'blob-name', 'hmac'),
    ]).then(([manifestEnc, blobEnc, blobName]) => ({ manifestEnc, blobEnc, blobName }));
}

export function deriveDrivePackSubkeys(rootKeyRaw: Uint8Array, folderId: string): Promise<DrivePackSubkeys> {
    return Promise.all([
        hkdf(rootKeyRaw, folderId, 'chunk-enc-v2', 'aes'),
        hkdf(rootKeyRaw, folderId, 'pack-name-v2', 'hmac'),
        hkdf(rootKeyRaw, folderId, 'manifest-enc-v2', 'aes'),
    ]).then(([chunkEnc, packName, manifestEnc]) => ({ chunkEnc, packName, manifestEnc }));
}

export async function hmacNameFor(blobNameKey: CryptoKey, contentHash: string): Promise<string> {
    const mac = await crypto.subtle.sign('HMAC', blobNameKey, encoder.encode(contentHash) as BufferSource);
    return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}
