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
        // 자사(MiiWAN) / 시장(3사) 정체성 액센트. own == group.miiwan 값과 동일.
        // own 은 status-green과 충돌하지 않도록 네비·정체성 영역에만 사용(데이터 긍정색 아님).
        own:    "#75d7d1", // 자사 MiiWAN 메인
        "own-weak": "rgba(117, 215, 209, 0.12)",
        market: "#ABE3E4", // 3사 / 시장 컨텍스트
        // groups.ts(GROUP_COLORS) 와 1:1 미러 — 둘 다 바꿀 것.
        group: {
          plave:    "#ec4899",
          isedol:   "#22c55e",
          stellive: "#818cf8",
          skinz:    "#f59e0b",
          myrakl:   "#a855f7",
          owis:     "#3b82f6",
          miiwan:   "#75d7d1",
          bdawn:    "#ef4444",
          wegosix:  "#f97316",
          uryael:   "#84cc16",
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
