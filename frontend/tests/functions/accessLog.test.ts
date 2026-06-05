import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  isDocumentLoad,
  shortCid,
  safeKeyEqual,
  renderAdminHtml,
} from "../../functions/lib/accessLog";

const docReq = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://x${path}`, { method, headers });

describe("accessLog helpers", () => {
  it("ACCESS_COOKIE name is stable", () => {
    expect(ACCESS_COOKIE).toBe("idol_radar_cid");
  });

  describe("isDocumentLoad", () => {
    it("true for GET document navigation", () => {
      expect(isDocumentLoad(docReq("/", { "sec-fetch-dest": "document" }), "/")).toBe(true);
    });
    it("true for GET with text/html accept and no sec-fetch-dest", () => {
      expect(isDocumentLoad(docReq("/group/plave", { accept: "text/html,*/*" }), "/group/plave")).toBe(true);
    });
    it("false for non-GET", () => {
      expect(isDocumentLoad(docReq("/", { "sec-fetch-dest": "document" }, "POST"), "/")).toBe(false);
    });
    it("false for /api paths", () => {
      expect(isDocumentLoad(docReq("/api/ping", { "sec-fetch-dest": "document" }), "/api/ping")).toBe(false);
    });
    it("false for /admin paths", () => {
      expect(isDocumentLoad(docReq("/admin/access", { "sec-fetch-dest": "document" }), "/admin/access")).toBe(false);
    });
    it("false for /assets and /__auth", () => {
      expect(isDocumentLoad(docReq("/assets/app.js", { "sec-fetch-dest": "script" }), "/assets/app.js")).toBe(false);
      expect(isDocumentLoad(docReq("/__auth", { "sec-fetch-dest": "document" }), "/__auth")).toBe(false);
    });
    it("false when neither sec-fetch-dest nor html accept present", () => {
      expect(isDocumentLoad(docReq("/foo"), "/foo")).toBe(false);
    });
  });

  describe("shortCid", () => {
    it("strips dashes and takes first 6 hex", () => {
      expect(shortCid("abcdef12-3456-7890-abcd-ef1234567890")).toBe("#abcdef");
    });
  });

  describe("safeKeyEqual", () => {
    it("true for equal", () => expect(safeKeyEqual("s3cret", "s3cret")).toBe(true));
    it("false for different value", () => expect(safeKeyEqual("s3cret", "s3creT")).toBe(false));
    it("false for different length", () => expect(safeKeyEqual("ab", "abc")).toBe(false));
    it("false for empty vs nonempty", () => expect(safeKeyEqual("", "x")).toBe(false));
  });

  describe("renderAdminHtml", () => {
    it("renders weekly + per-person numbers", () => {
      const html = renderAdminHtml(
        [{ wk: "2026-22", visitors: 12, hits: 80 }],
        [{ cid: "#abc123", hits: 9 }],
      );
      expect(html).toContain("2026-22");
      expect(html).toContain("12");
      expect(html).toContain("#abc123");
      expect(html).toContain("9");
    });
    it("shows 데이터 없음 when empty", () => {
      const html = renderAdminHtml([], []);
      expect(html).toContain("데이터 없음");
    });
    it("HTML-escapes a malicious cid value (untrusted cookie)", () => {
      const html = renderAdminHtml([], [{ cid: '#</td><img src=x>', hits: 1 }]);
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;/td&gt;&lt;img src=x&gt;");
    });
  });
});
