import type { ReactNode } from "react";
import { navigate, useStore } from "../lib/store";
import { preloadRoute } from "../lib/route-preload";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const path = useStore((s) => s.path);
  return <a href={to} className={className} aria-current={path === to ? "page" : undefined}
    onPointerEnter={() => preloadRoute(to)} onFocus={() => preloadRoute(to)}
    onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      preloadRoute(to);
      navigate(to);
    }}>{children}</a>;
}
