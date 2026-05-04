import "./styles.css";

const root = document.getElementById("app")!;
root.innerHTML = `
  <main class="mx-auto max-w-3xl p-8">
    <h1 class="text-2xl font-bold">IDOL-SIGHT</h1>
    <p class="mt-2 text-zinc-400">Foundation phase — UI is added in Plan 4.</p>
    <p id="ping-status" class="mt-4 text-sm text-zinc-500">Pinging API…</p>
  </main>
`;

fetch("/api/ping")
  .then((r) => r.text())
  .then((t) => {
    const el = document.getElementById("ping-status")!;
    el.textContent = `API: ${t}`;
  })
  .catch((e) => {
    const el = document.getElementById("ping-status")!;
    el.textContent = `API error: ${String(e)}`;
  });
