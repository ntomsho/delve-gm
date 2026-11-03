/**
 * The web's palette (`src/index.css`), as values. React Native has no CSS
 * variables, and a colour is passed to a style as a plain string.
 */
export const color = {
  desk: "#ede7da",
  paper: "#f6f2e8",
  panel: "#f1ebdf",
  rule: "#cfc7b4",
  ink: "#22201c",
  graphite: "#6b6659",
  pencil: "#a69e8d",
  torch: "#b4521e",
  torchWash: "#f7ede4",
} as const;

/**
 * Android's built-in families until the web's fonts are loaded in a later phase.
 * `serif` is Noto Serif and `monospace` is Droid Sans Mono.
 */
export const font = {
  prose: "serif",
  mono: "monospace",
} as const;
