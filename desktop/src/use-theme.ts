import { useEffect } from "react";
import {
  resolveTheme,
  seasonalThemes,
  type ThemePreference,
} from "../shared/themes";

export function useTheme(preference: ThemePreference = "system") {
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const root = document.documentElement;
    const apply = () => {
      const { mode, seasonal } = resolveTheme(preference, media.matches);
      root.dataset.theme = mode;
      // Clear prior inline tokens before switching back to the classic palette.
      for (const token of Object.keys(seasonalThemes[0].colors))
        root.style.removeProperty(`--${token}`);
      if (seasonal) {
        root.dataset.season = seasonal.season;
        root.dataset.appearance = seasonal.id;
        for (const [token, value] of Object.entries(seasonal.colors))
          root.style.setProperty(`--${token}`, value);
      } else {
        delete root.dataset.season;
        delete root.dataset.appearance;
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      for (const token of Object.keys(seasonalThemes[0].colors))
        root.style.removeProperty(`--${token}`);
      delete root.dataset.season;
      delete root.dataset.appearance;
      root.dataset.theme = media.matches ? "dark" : "light";
    };
  }, [preference]);
}
