/**
 * Suorittaa tehtävät enintään `limit` rinnakkain. Ensimmäinen virhe pysäyttää uusien tehtävien
 * aloituksen ja heitetään kutsujalle; osittaista tulosta ei palauteta.
 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let error: unknown;
  const worker = async () => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (!failed) {
          failed = true;
          error = e;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw error;
  return results;
}
