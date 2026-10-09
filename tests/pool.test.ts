import { describe, expect, it } from "vitest";
import { mapPool } from "../lib/util/pool";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapPool", () => {
  it("säilyttää järjestyksen ja rajoittaa rinnakkaisuuden", async () => {
    let inflight = 0;
    let max = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inflight++;
      max = Math.max(max, inflight);
      await sleep(5 - n);
      inflight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(max).toBe(2);
  });

  it("raja 1 on peräkkäinen; tyhjä lista toimii", async () => {
    let max = 0;
    let inflight = 0;
    await mapPool([1, 2, 3], 1, async () => {
      inflight++;
      max = Math.max(max, inflight);
      await sleep(1);
      inflight--;
    });
    expect(max).toBe(1);
    expect(await mapPool([], 3, async (x) => x)).toEqual([]);
  });

  it("ensimmäinen virhe heitetään eikä uusia tehtäviä aloiteta", async () => {
    const started: number[] = [];
    await expect(
      mapPool([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("rikki");
        return n;
      }),
    ).rejects.toThrow("rikki");
    expect(started).toEqual([1, 2]);
  });
});
