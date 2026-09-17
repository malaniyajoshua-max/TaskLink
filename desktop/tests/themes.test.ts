import { describe, expect, it } from "vitest";
import { seasonalThemes, resolveTheme } from "../shared/themes";
import { preferencesPatchSchema } from "../shared/contract";

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
describe("seasonal theme readability", () => {
  for (const theme of seasonalThemes) {
    it(`${theme.id} preserves text, secondary labels and button contrast`, () => {
      const c = theme.colors;
      for (const bg of ["canvas", "sidebar", "surface", "soft", "selected"])
        for (const fg of ["text", "muted", "accent"])
          expect(
            contrast(c[fg], c[bg]),
            `${fg} on ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
      for (const bg of ["accent", "accent-hover"])
        expect(contrast(c["on-accent"], c[bg])).toBeGreaterThanOrEqual(4.5);
      expect(preferencesPatchSchema.parse({ theme: theme.id })).toEqual({
        theme: theme.id,
      });
      expect(resolveTheme(theme.id, theme.mode !== "dark").mode).toBe(
        theme.mode,
      );
    });
  }
  it("keeps legacy palettes and system-following behavior distinct from explicit seasonal choices", () => {
    expect(resolveTheme("system", true)).toEqual({
      mode: "dark",
      seasonal: undefined,
    });
    expect(resolveTheme("system", false)).toEqual({
      mode: "light",
      seasonal: undefined,
    });
    expect(resolveTheme("light", true).mode).toBe("light");
    expect(resolveTheme("dark", false).mode).toBe("dark");
    expect(new Set(seasonalThemes.map((theme) => theme.id)).size).toBe(8);
  });
});
