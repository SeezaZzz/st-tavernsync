/**
 * localforage instance for base manifest + scan cache.
 * Do NOT put bulk data in extensionSettings.
 * Unused until M2.
 */

import { MODULE_NAME } from '../settings';

let store: LocalForageInstance | null = null;

export function getSyncStore(): LocalForageInstance {
    if (store) {
        return store;
    }
    store = SillyTavern.libs.localforage.createInstance({
        name: MODULE_NAME,
        storeName: 'sync_state',
    });
    return store;
}

/**
 * คีย์เดิมสมัยมี backend เดียว — ไม่ใช้เขียนใหม่แล้ว เก็บไว้เพื่อย้ายของเก่าเข้าคีย์ที่มี namespace
 * @deprecated ใช้ baseStorageKey(namespace) แทน
 */
export const LEGACY_BASE_KEY = 'tavernsync_base';

/**
 * Base manifest (สถานะซิงก์ล่าสุด) แยกตาม backend เหมือน e2eeKeyStorageKey ด้านล่าง —
 * ต้องแยก เพราะถ้าใช้เล่มเดียวร่วมกัน พอสลับ backend ไปหาคลาวด์ที่ยังว่าง
 * diff จะอ่าน "อยู่ในสมุดแต่ไม่มีบนคลาวด์" เป็น remote_delete (= ฝั่งโน้นลบทิ้ง)
 * แทนที่จะเป็น "ยังไม่ได้อัป" แล้วข้ามไฟล์ทั้งหมดเงียบ ๆ ทั้งที่ยังไม่ได้ backup จริง
 */
export function baseStorageKey(namespace: string): string {
    return `tavernsync_base:${namespace}`;
}
/**
 * Raw AES-GCM key (base64) for remembered-device E2EE, namespaced per backend
 * (e.g. "http:<host>" or "drive:<folderId>"). Never store the passphrase.
 */
export function e2eeKeyStorageKey(namespace: string): string {
    return `tavernsync_e2ee_key_b64:${namespace}`;
}
