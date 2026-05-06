export function LoginGate() {
  const params = new URLSearchParams(location.search);
  const failed = params.get("err") === "1";
  return (
    <div class="grid min-h-screen place-items-center p-4">
      <form method="POST" action="/__auth"
            class="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <div class="mb-4 flex items-center gap-2">
          <span class="text-3xl">📊</span>
          <div>
            <h2 class="text-lg font-bold">MiiWAN Orbit</h2>
            <p class="text-xs text-zinc-500">Internal access</p>
          </div>
        </div>
        {failed && (
          <p class="mb-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
            비밀번호가 올바르지 않습니다.
          </p>
        )}
        <input type="password" name="password" required autofocus
               placeholder="Password"
               class="mb-3 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none" />
        <button class="w-full rounded bg-violet-500 px-3 py-2 text-sm font-semibold hover:bg-violet-600">
          Enter
        </button>
      </form>
    </div>
  );
}
