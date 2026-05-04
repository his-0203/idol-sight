import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface CrawlMetaRow {
  job: string;
  last_success_at: string | null;
  expected_interval_h: number | null;
  status: string | null;
  error_msg: string | null;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const rows = await d1Query<CrawlMetaRow>(
    env.DB,
    "SELECT job, last_success_at, expected_interval_h, status, error_msg "
    + "FROM crawl_meta ORDER BY job",
  );
  const newest = rows
    .map((r) => r.last_success_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop() ?? null;
  return jsonResponse({ global_last_success_at: newest, by_job: rows });
};
