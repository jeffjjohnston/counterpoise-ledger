import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");

/** The value of each CSS variable in the first block that the selector opens. */
function variables(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return new Map([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(([, name, value]) => [name, value]));
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("chart palette", () => {
  for (const selector of [":root", ".dark"]) {
    it(`gives 8 chart colors with 3:1 contrast in ${selector}`, () => {
      const vars = variables(selector);
      const background = vars.get("--bg-primary");
      expect(background).toBeDefined();
      for (let n = 1; n <= 8; n++) {
        const color = vars.get(`--chart-${n}`);
        expect(color, `--chart-${n}`).toBeDefined();
        expect(contrast(color!, background!), `--chart-${n}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
