import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Canvas } from "./canvas.tsx";
import "./index.css";
import { Overview } from "./overview.tsx";

function App() {
  const m = location.pathname.match(/^\/p\/([a-f0-9]+)\/([a-z0-9][a-z0-9-]*)\/?$/);
  return m ? <Canvas project={m[1]} feature={m[2]} /> : <Overview />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
