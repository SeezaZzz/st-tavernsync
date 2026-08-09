import { describe, it, expect, beforeEach } from 'vitest';
import { loadBase, saveBase, clearBase, type BaseState } from '../engine';
import {
    LEGACY_BASE_KEY,
    baseStorageKey,
    clearBackendState,
    clearDriveV2Base,
    driveV2BaseStorageKey,
    e2eeKeyStorageKey,
    loadDriveV2Base,
    saveDriveV2Base,
} from '../../state/store';
import { emptyManifest } from '../../sync-core/types';

/** localforage ปลอม — เก็บใน Map ให้ตรวจคีย์ที่ถูกเขียนจริงได้ */
const items = new Map<string, unknown>();
const fakeStore = {
    getItem: async (k: string) => (items.has(k) ? items.get(k) : null),
    setItem: async (k: string, v: unknown) => { items.set(k, v); return v; },
    removeItem: async (k: string) => { items.delete(k); },
    clear: async () => { items.clear(); },
};

const settings: Record<string, unknown> = {};

function useDriveFolder(folderId: string): void {
    settings.backendMode = 'drive';
    settings.driveFolderId = folderId;
}

function baseFor(device: string): BaseState {
    return { manifest: emptyManifest(device), syncedAt: 1, remoteVersion: '1' };
}

beforeEach(() => {
    items.clear();
    for (const k of Object.keys(settings)) delete settings[k];
    useDriveFolder('FOLDER_A');
    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        libs: { localforage: { createInstance: () => fakeStore } },
        getContext: () => ({ extensionSettings: { tavernsync: settings } }),
    };
});

describe('base state is namespaced per backend', () => {
    it('เขียนลงคีย์ที่มี namespace ของ backend ปัจจุบัน', async () => {
        await saveBase(baseFor('pc'));
        expect(items.has(baseStorageKey('drive:FOLDER_A'))).toBe(true);
        expect(items.has(LEGACY_BASE_KEY)).toBe(false);
    });

    // นี่คือบั๊กที่แก้: เดิมใช้คีย์เดียวร่วมกัน พอสลับ backend สมุดเก่าติดไปด้วย
    // แล้ว diff อ่าน "ยังไม่ได้อัป" เป็น "ฝั่งโน้นลบทิ้ง" → ข้ามไฟล์เกือบทั้งหมดเงียบ ๆ
    it('สลับ folder แล้วไม่เห็นสมุดของ folder เดิม', async () => {
        await saveBase(baseFor('pc'));
        expect(await loadBase()).not.toBeNull();

        useDriveFolder('FOLDER_B');
        expect(await loadBase()).toBeNull();

        useDriveFolder('FOLDER_A');
        expect(await loadBase()).not.toBeNull();
    });

    it('drive กับ http แยกสมุดกัน', async () => {
        await saveBase(baseFor('drive-device'));

        settings.backendMode = 'http';
        settings.endpoint = 'https://sync.example.com';
        expect(await loadBase()).toBeNull();
    });
});

describe('legacy base migration', () => {
    it('ย้ายสมุดเล่มเก่าเข้าคีย์ใหม่ครั้งเดียว แล้วลบของเก่าทิ้ง', async () => {
        items.set(LEGACY_BASE_KEY, baseFor('old-device'));

        const loaded = await loadBase();
        expect(loaded?.manifest.device).toBe('old-device');
        expect(items.has(baseStorageKey('drive:FOLDER_A'))).toBe(true);
        expect(items.has(LEGACY_BASE_KEY)).toBe(false); // ย้ายแล้วต้องไม่เหลือ
    });

    it('ถ้ามีสมุดของ backend นี้อยู่แล้ว ห้ามให้ของเก่าทับ', async () => {
        await saveBase(baseFor('current'));
        items.set(LEGACY_BASE_KEY, baseFor('stale'));

        const loaded = await loadBase();
        expect(loaded?.manifest.device).toBe('current');
    });

    it('clearBase ล้างทั้งคีย์ใหม่และของเก่า', async () => {
        await saveBase(baseFor('pc'));
        items.set(LEGACY_BASE_KEY, baseFor('old'));

        await clearBase();
        expect(items.has(baseStorageKey('drive:FOLDER_A'))).toBe(false);
        expect(items.has(LEGACY_BASE_KEY)).toBe(false);
    });
});

describe('backend state cleanup', () => {
    it('namespaces the Drive v2 base by Drive root', async () => {
        await saveDriveV2Base('drive:root-a', { commitId: 'a', syncedAt: 1 });
        await saveDriveV2Base('drive:root-b', { commitId: 'b', syncedAt: 2 });

        await expect(loadDriveV2Base('drive:root-a')).resolves.toEqual({ commitId: 'a', syncedAt: 1 });
        await clearDriveV2Base('drive:root-a');
        await expect(loadDriveV2Base('drive:root-a')).resolves.toBeNull();
        await expect(loadDriveV2Base('drive:root-b')).resolves.toEqual({ commitId: 'b', syncedAt: 2 });
    });

    it('removes only the selected base and remembered key namespace', async () => {
        items.set(baseStorageKey('drive:FOLDER_A'), baseFor('a'));
        items.set(e2eeKeyStorageKey('drive:FOLDER_A'), 'key-a');
        items.set(driveV2BaseStorageKey('drive:FOLDER_A'), { commitId: 'v2-a', syncedAt: 1 });
        items.set(baseStorageKey('drive:FOLDER_B'), baseFor('b'));
        items.set(e2eeKeyStorageKey('drive:FOLDER_B'), 'key-b');

        await clearBackendState('drive:FOLDER_A');

        expect(items.has(baseStorageKey('drive:FOLDER_A'))).toBe(false);
        expect(items.has(e2eeKeyStorageKey('drive:FOLDER_A'))).toBe(false);
        expect(items.has(driveV2BaseStorageKey('drive:FOLDER_A'))).toBe(false);
        expect(items.has(baseStorageKey('drive:FOLDER_B'))).toBe(true);
        expect(items.has(e2eeKeyStorageKey('drive:FOLDER_B'))).toBe(true);
    });
});
