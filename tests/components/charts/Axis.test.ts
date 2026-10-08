import { describe, expect, it } from "vitest";
import { scaleLinear } from "d3-scale";
import { tickLabelWidth, valueTicks } from "@/components/charts/Axis";

describe("valueTicks", () => {
  it("gives a different label to each tick on a narrow range", () => {
    const scale = scaleLinear().domain([29_100_000, 29_400_000]).range([100, 0]);
    const labels = valueTicks(scale, 5).map((tick) => tick.label);
    expect(labels.length).toBeGreaterThan(2);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps the short labels on a wide range", () => {
    const scale = scaleLinear().domain([0, 500_000]).range([100, 0]);
    expect(valueTicks(scale, 5).map((tick) => tick.label)).toContain("$1k");
  });

  it("gives a different label to each tick near $1M with ticks $50 apart", () => {
    const scale = scaleLinear().domain([100_000_000, 100_020_000]).range([100, 0]);
    const ticks = valueTicks(scale, 5);
    expect(ticks.map((tick) => tick.value)).toContain(100_005_000);
    const labels = ticks.map((tick) => tick.label);
    expect(labels).toContain("$1.00005M");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives decimal dollars to ticks 50 cents apart below $1", () => {
    const scale = scaleLinear().domain([0, 200]).range([100, 0]);
    expect(valueTicks(scale, 5).map((tick) => tick.label)).toEqual(["$0", "$0.5", "$1", "$1.5", "$2"]);
  });

  it("drops a tick that is not a whole number of cents", () => {
    const scale = scaleLinear().domain([0, 3]).range([100, 0]);
    expect(scale.ticks(5)).toContain(0.5);
    const ticks = valueTicks(scale, 5);
    expect(ticks.map((tick) => tick.value)).toEqual([0, 1, 2, 3]);
    expect(ticks.map((tick) => tick.label)).toEqual(["$0", "$0.01", "$0.02", "$0.03"]);
  });
});

describe("tickLabelWidth", () => {
  it("estimates 6 px for each character of the longest label, with a gap", () => {
    const tick = (label: string) => ({ value: 0, position: 0, label });
    expect(tickLabelWidth([tick("$1M"), tick("−$1.00005M")])).toBe(68);
    expect(tickLabelWidth([])).toBe(8);
  });
});
