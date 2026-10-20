import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./Landing";
import { Editor, type Mode } from "./Editor";
import "./styles.css";

export type Route =
  | { page: "landing" }
  | { page: "editor"; lecture: string; mode: Mode; short?: string };

function parse(hash: string): Route {
  const m = hash.match(/^#\/l\/([a-f0-9]{12})\/(studio|read)(?:\/([a-f0-9]{12}))?/);
  if (m) return { page: "editor", lecture: m[1], mode: m[2] as Mode, short: m[3] };
  return { page: "landing" };
}

export function go(route: Route) {
  location.hash = route.page === "landing"
    ? "#/"
    : `#/l/${route.lecture}/${route.mode}${route.short ? `/${route.short}` : ""}`;
}

function App() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (route.page === "editor") {
    return <Editor key={route.lecture} lectureId={route.lecture} mode={route.mode} shortId={route.short} />;
  }
  return <Landing />;
}

createRoot(document.getElementById("root")!).render(<App />);
