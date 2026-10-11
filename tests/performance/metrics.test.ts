import { describe, expect, it } from "vitest";
import { consoleAssetBytes } from "../../scripts/console-asset-metrics";
import { distribution, labCls } from "./metrics";

describe("bounded console lab evidence", () => {
  it("counts UTF-8 bytes, with repeatable fixed compression", () => {
    const value = "密钥😀";
    expect(consoleAssetBytes(value).utf8).toBe(10);
    expect(consoleAssetBytes(value)).toEqual(consoleAssetBytes(Buffer.from(value)));
  });
  it("keeps unavailable observations missing and reports finite-sample spread", () => {
    expect(distribution([1, 2, 3, 4, 5, null])).toEqual({ samples: 5, missing: 1, min: 1, median: 3, max: 5, mean: 3, sampleSd: Math.sqrt(2.5) });
    expect(distribution([null]).median).toBeNull();
    expect(distribution([0]).sampleSd).toBeNull();
  });
  it("uses CLS session windows and excludes recent-input shifts", () => {
    expect(labCls([{startTime: 0, value: .1, hadRecentInput: false}, {startTime: 500, value: .2, hadRecentInput: false},
      {startTime: 600, value: 9, hadRecentInput: true}, {startTime: 1600, value: .15, hadRecentInput: false}])).toBeCloseTo(.3);
    expect(labCls(Array.from({length: 8}, (_, i) => ({startTime: i*900, value: .1, hadRecentInput: false})))).toBeCloseTo(.6);
  });
});
