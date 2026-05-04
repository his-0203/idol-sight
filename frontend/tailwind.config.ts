import type { Config } from "tailwindcss";

// Design tokens. Keep raw hex values mirrored from src/design/groups.ts and
// src/design/grades.ts so utility classes (bg-group-plave, text-grade-S) are
// available alongside the JS-side colorOf()/gradeClasses() helpers.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#8b5cf6", // violet-500 — IDOL-SIGHT mark only
          fg:      "#c4b5fd", // violet-300 — text-on-dark
          weak:    "rgba(139, 92, 246, 0.20)",
        },
        group: {
          plave:    "#ec4899",
          isedol:   "#22c55e",
          stellive: "#06b6d4",
          skinz:    "#f59e0b",
          myrakl:   "#a855f7",
          owis:     "#3b82f6",
          miiwan:   "#14b8a6",
          bdawn:    "#ef4444",
        },
        grade: {
          S:   "#10b981",
          A:   "#3b82f6",
          B:   "#06b6d4", // cyan, NOT violet (brand reservation)
          C:   "#f59e0b",
          D:   "#ef4444",
          PRE: "#71717a",
        },
        surface: {
          DEFAULT: "var(--surface)",
          fg:      "var(--surface-fg)",
          border:  "var(--surface-border)",
          muted:   "var(--surface-muted)",
        },
      },
      fontSize: {
        // Semantic scale — prefer over text-[10px] / arbitrary sizes.
        // hint  : footnotes, source refs       (11px)
        // label : KPI labels (uppercase)       (12px)
        // data  : table cells, dense numerics  (13px)
        // body  : default paragraph            (14px)
        hint:  ["11px", { lineHeight: "1.4" }],
        label: ["12px", { lineHeight: "1.3", letterSpacing: "0.04em" }],
        data:  ["13px", { lineHeight: "1.4" }],
        body:  ["14px", { lineHeight: "1.5" }],
      },
      borderRadius: {
        card: "0.625rem", // 10px — cards, sections
        ctrl: "0.375rem", // 6px  — buttons, inputs
        chip: "0.25rem",  // 4px  — small chips/badges
      },
    },
  },
  plugins: [],
} satisfies Config;
