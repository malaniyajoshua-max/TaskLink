import { z } from "zod";

export const themeSchema = z.enum([
  "system",
  "light",
  "dark",
  "spring-day",
  "spring-night",
  "summer-day",
  "summer-night",
  "autumn-day",
  "autumn-night",
  "winter-day",
  "winter-night",
]);
export type ThemePreference = z.infer<typeof themeSchema>;
export type SeasonalThemeId = Exclude<
  ThemePreference,
  "system" | "light" | "dark"
>;
export interface SeasonalTheme {
  id: SeasonalThemeId;
  season: "spring" | "summer" | "autumn" | "winter";
  mode: "light" | "dark";
  name: string;
  description: string;
  colors: Record<string, string>;
}

// Semantic roles are shared by the task workspace and the separate chat window.
// Keep text colors independent from decorative colors: a pale seasonal highlight
// should never become unreadable small text or a white-on-pastel primary button.
function palette(mode: "light" | "dark", values: string[]) {
  const [
    canvas,
    sidebar,
    surface,
    soft,
    text,
    muted,
    line,
    accent,
    hover,
    selected,
    detail,
  ] = values;
  return {
    canvas,
    sidebar,
    surface,
    soft,
    text,
    muted,
    line,
    accent,
    "accent-hover": hover,
    selected,
    "season-detail": detail,
    subtle: muted,
    nav: sidebar,
    "nav-text": text,
    "nav-muted": muted,
    "nav-selected": selected,
    "on-accent": mode === "light" ? "#ffffff" : "#102126",
    danger: mode === "light" ? "#ad353f" : "#ffadb1",
    "danger-soft": mode === "light" ? "#fff0f0" : "#42282d",
    success: mode === "light" ? "#246847" : "#94dbb6",
    warning: mode === "light" ? "#865213" : "#f1c67f",
    shadow:
      mode === "light"
        ? "0 24px 80px #182d3920, 0 3px 12px #182d3908"
        : "0 24px 80px #0007",
  };
}
export const seasonalThemes: SeasonalTheme[] = [
  {
    id: "spring-day",
    season: "spring",
    mode: "light",
    name: "春 · 晨芽",
    description: "青芽、米白与浅樱",
    colors: palette("light", [
      "#f7faf5",
      "#edf3e9",
      "#ffffff",
      "#f0f5ec",
      "#243d31",
      "#56685a",
      "#d8e4d4",
      "#35734d",
      "#295d3d",
      "#e0eedb",
      "#c67c91",
    ]),
  },
  {
    id: "spring-night",
    season: "spring",
    mode: "dark",
    name: "春 · 夜庭",
    description: "深林、嫩绿与花影",
    colors: palette("dark", [
      "#14231f",
      "#101e1a",
      "#1c2d27",
      "#263b32",
      "#e7f2e5",
      "#adc3b2",
      "#385044",
      "#add69c",
      "#c3e6b4",
      "#304a36",
      "#d5a0b5",
    ]),
  },
  {
    id: "summer-day",
    season: "summer",
    mode: "light",
    name: "夏 · 晴海",
    description: "海蓝、瓷白与日光",
    colors: palette("light", [
      "#f4fafb",
      "#e6f2f5",
      "#ffffff",
      "#eaf4f7",
      "#193f4b",
      "#506974",
      "#d1e4ea",
      "#08718b",
      "#075b71",
      "#dceff4",
      "#d29b36",
    ]),
  },
  {
    id: "summer-night",
    season: "summer",
    mode: "dark",
    name: "夏 · 潮夜",
    description: "深海、青碧与微光",
    colors: palette("dark", [
      "#101f2d",
      "#0b1925",
      "#182d3c",
      "#213b4b",
      "#e3f4f6",
      "#a2c1cc",
      "#305063",
      "#76d8d0",
      "#9ae9e1",
      "#244849",
      "#e6c27c",
    ]),
  },
  {
    id: "autumn-day",
    season: "autumn",
    mode: "light",
    name: "秋 · 麦光",
    description: "陶土、燕麦与金叶",
    colors: palette("light", [
      "#fbf7f0",
      "#f2e9dc",
      "#fffdf9",
      "#f5eee4",
      "#49372b",
      "#76604f",
      "#e7d9c8",
      "#9b4f2c",
      "#7e3e22",
      "#f3e2cf",
      "#ad842e",
    ]),
  },
  {
    id: "autumn-night",
    season: "autumn",
    mode: "dark",
    name: "秋 · 暮火",
    description: "胡桃、铜橙与暖灯",
    colors: palette("dark", [
      "#29201c",
      "#211915",
      "#352a23",
      "#44352a",
      "#f6ead7",
      "#cebba5",
      "#574335",
      "#edb278",
      "#f5c99e",
      "#513c29",
      "#bfaa71",
    ]),
  },
  {
    id: "winter-day",
    season: "winter",
    mode: "light",
    name: "冬 · 霁雪",
    description: "霜白、冰蓝与银灰",
    colors: palette("light", [
      "#f5f8fc",
      "#e9eef6",
      "#ffffff",
      "#eef2f8",
      "#2c3a53",
      "#5b6880",
      "#d8e0ed",
      "#4a6198",
      "#394d7d",
      "#e4ebf8",
      "#8a92bb",
    ]),
  },
  {
    id: "winter-night",
    season: "winter",
    mode: "dark",
    name: "冬 · 星霜",
    description: "靛夜、月银与冰晶",
    colors: palette("dark", [
      "#191e30",
      "#12182a",
      "#222a40",
      "#2d3650",
      "#edf0fc",
      "#b4bfd9",
      "#3b4764",
      "#b0c5f8",
      "#cbd9ff",
      "#354360",
      "#c5b6de",
    ]),
  },
];

export function resolveTheme(preference: ThemePreference, systemDark: boolean) {
  const seasonal = seasonalThemes.find((theme) => theme.id === preference);
  return {
    mode:
      seasonal?.mode ??
      (preference === "system"
        ? systemDark
          ? "dark"
          : "light"
        : preference === "dark"
          ? "dark"
          : "light"),
    seasonal,
  };
}
