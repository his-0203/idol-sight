import { useState } from "preact/hooks";

export function ShareLink() {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      class="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
      onClick={onClick}
      title="현재 화면 URL 복사"
    >{copied ? "복사됨 ✓" : "공유 링크"}</button>
  );
}
