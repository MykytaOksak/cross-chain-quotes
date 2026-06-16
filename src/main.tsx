import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IS_HOSTED_MODE } from "./modes";
import "./styles.css";

function setLocalFavicon(): void {
  if (IS_HOSTED_MODE) return;
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
    link.href = "/cq-logo-local.png";
  });
}

setLocalFavicon();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
