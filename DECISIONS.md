# Decisions

## 2026-11-24 – Single light theme, Geist fonts

- **Decision:** The UI uses one light theme only (indigo accent, design tokens as CSS variables in `src/styles.css`). Fonts are Geist and Geist Mono, bundled locally via `@fontsource-variable/*`.
- **Reason:** A modern, readable debugging tool; the light theme is the deliberate choice, a dark theme is not planned. Fonts are bundled because the app runs locally and offline, without external CDNs.
- **Context bar colors:** Context sections use a validated categorical order (blue, orange, aqua, yellow, magenta, green) that stays distinguishable for colour-vision deficiencies; the legend always shows labels and values.
