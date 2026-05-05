import type { JSX } from "preact";

export function exportCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const first = rows[0];
  if (!first) return;
  const cols = Object.keys(first);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function exportPng(canvas: HTMLCanvasElement, filename: string): void {
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
}

export function ExportMenu(props: { rows?: Record<string, unknown>[]; canvas?: HTMLCanvasElement;
                                   filenameBase: string }): JSX.Element {
  return (
    <div class="flex gap-1">
      {props.rows && (
        <button
          class="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          onClick={() => exportCsv(`${props.filenameBase}.csv`, props.rows!)}
        >CSV</button>
      )}
      {props.canvas && (
        <button
          class="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          onClick={() => exportPng(props.canvas!, `${props.filenameBase}.png`)}
        >PNG</button>
      )}
    </div>
  );
}
