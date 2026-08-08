/** Run async work over items with a fixed concurrency cap. */
export async function mapPool<T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) return [];

    const results = new Array<R>(items.length);
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    let nextIndex = 0;
    let stopped = false;

    await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
            if (stopped) return;
            const index = nextIndex++;
            if (index >= items.length) return;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                stopped = true;
                throw error;
            }
        }
    }));

    return results;
}
