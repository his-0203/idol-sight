import { readState, writeState } from "./router";

export function applyTheme(): void {
  const t = readState().theme;
  document.documentElement.classList.toggle("light", t === "light");
  document.documentElement.classList.toggle("dark", t === "dark");
}

export function toggleTheme(): void {
  const t = readState().theme;
  writeState({ theme: t === "dark" ? "light" : "dark" });
  applyTheme();
}
