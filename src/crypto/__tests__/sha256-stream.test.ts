import { expect, it } from 'vitest';

import { Sha256Stream } from '../sha256-stream';

it('matches SHA-256 vectors across arbitrary update boundaries', () => {
    const hash = new Sha256Stream();
    hash.update(new TextEncoder().encode('a'));
    hash.update(new TextEncoder().encode('bc'));

    expect(hash.hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

it('hashes a multi-block value without retaining the source', () => {
    const hash = new Sha256Stream();
    for (let index = 0; index < 1_000; index++) hash.update(new Uint8Array([97]));

    expect(hash.hex()).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(() => hash.update(new Uint8Array([1]))).toThrow(/finalized/i);
});
