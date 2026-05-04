export const onRequestGet: PagesFunction = async () =>
  new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
