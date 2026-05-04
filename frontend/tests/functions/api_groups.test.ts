import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/groups";

const envWith = (rows: any[]) => ({
  DB: { prepare: vi.fn(() => ({ bind: vi.fn().mockReturnThis(),
                                 all: vi.fn(async () => ({ results: rows })) })) },
} as any);

describe("/api/groups", () => {
  it("returns active groups with parsed lists", async () => {
    const env = envWith([
      { key: "plave", name: "PLAVE", name_kr: "플레이브",
        debut_date: "2023-03-12", yt_channel_id: "UC...", dc_gallery_id: "plave",
        context_keywords: '["플레이브","PLAVE"]', is_active: 1, has_data: 1 },
    ]);
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].context_keywords).toEqual(["플레이브", "PLAVE"]);
    expect(body.groups[0].has_data).toBe(true);
  });
});
