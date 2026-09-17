import type { CSSProperties } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { seasonalThemes, type ThemePreference } from "../../shared/themes";

export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  return (
    <div className="theme-picker">
      <div className="theme-picker-heading">
        <div>
          <b>四季 · 日与夜</b>
          <p>八种季节配色，为每一天选择合适的光线。</p>
        </div>
        <span>即时切换 · 本机保存</span>
      </div>
      <div className="season-theme-grid" role="group" aria-label="四季主题">
        {seasonalThemes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={`season-theme-card ${value === theme.id ? "is-selected" : ""}`}
            aria-label={`选择${theme.name}`}
            aria-pressed={value === theme.id}
            onClick={() => onChange(theme.id)}
            style={
              Object.fromEntries(
                Object.entries(theme.colors).map(([key, color]) => [
                  `--preview-${key}`,
                  color,
                ]),
              ) as CSSProperties
            }
          >
            <span
              className="theme-preview"
              aria-hidden="true"
              data-season={theme.season}
            >
              <span className="theme-preview-nav">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="theme-preview-main">
                <span className="theme-preview-heading" />
                <span className="theme-preview-tabs">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-preview-row">
                  <i />
                  <b />
                </span>
                <span className="theme-preview-row">
                  <i />
                  <b />
                </span>
                <span className="theme-preview-row">
                  <i />
                  <b />
                </span>
              </span>
              <span className="theme-preview-orbit" />
              <span className="theme-preview-light">
                {theme.mode === "light" ? (
                  <Sun size={15} />
                ) : (
                  <Moon size={15} />
                )}
              </span>
              {value === theme.id && (
                <span className="theme-preview-check">
                  <Check size={13} />
                </span>
              )}
            </span>
            <span className="theme-card-name">
              {theme.name}
              <small>{theme.mode === "light" ? "日间" : "夜间"}</small>
            </span>
            <span className="theme-card-description">{theme.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
