import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api/pendle": {
        target: "http://localhost:8788",
        changeOrigin: true,
      },
      "/api/telegram": {
        target: "http://localhost:4173",
        changeOrigin: true,
      },
      "/api/shared": {
        target: "http://localhost:4173",
        changeOrigin: true,
      },
    },
  },
});
