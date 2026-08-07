import { describe, expect, it } from 'vitest';
import { mergeManifestItems } from '../merge';
import type { SyncItem } from '../types';

function item(id: string, hash: string): SyncItem { return { id, type: 'worldinfo', hash, size: 1, mtime: 1 }; }

describe('mergeManifestItems (3-way)', () => {
    it('แก้ฝั่งเดียว → รับฝั่งนั้น', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const a = { 'w/a': item('w/a', 'h1') };
        const b = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, a, b);
        expect(r.merged['w/a'].hash).toBe('h1');
        expect(r.conflicts).toHaveLength(0);
    });

    it('ทั้งสองฝั่ง hash เดียวกัน → ไม่ conflict', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, { 'w/a': item('w/a', 'h9') }, { 'w/a': item('w/a', 'h9') });
        expect(r.conflicts).toHaveLength(0);
        expect(r.merged['w/a'].hash).toBe('h9');
    });

    it('แก้ชนกันคนละ hash → conflict พร้อม local/remote/base', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, { 'w/a': item('w/a', 'h1') }, { 'w/a': item('w/a', 'h2') });
        expect(r.conflicts).toHaveLength(1);
        expect(r.conflicts[0]).toMatchObject({ id: 'w/a', action: 'conflict' });
        expect(r.conflicts[0].local?.hash).toBe('h1');
        expect(r.conflicts[0].remote?.hash).toBe('h2');
        expect(r.conflicts[0].base?.hash).toBe('h0');
    });

    it('delete ชน edit → conflict', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, {}, { 'w/a': item('w/a', 'h2') });
        expect(r.conflicts).toHaveLength(1);
    });

    it('item ใหม่คนละฝั่ง → union ทั้งคู่ ไม่ conflict', () => {
        const r = mergeManifestItems({}, { 'w/a': item('w/a', 'h1') }, { 'w/b': item('w/b', 'h2') });
        expect(Object.keys(r.merged).sort()).toEqual(['w/a', 'w/b']);
        expect(r.conflicts).toHaveLength(0);
    });

    it('ทั้งคู่ลบ → ไม่อยู่ใน merged', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, {}, {});
        expect(r.merged['w/a']).toBeUndefined();
        expect(r.conflicts).toHaveLength(0);
    });
});
