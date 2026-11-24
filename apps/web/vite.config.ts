import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../client-qt/qml/assets/card-back.jpg", import.meta.url))] },
    proxy: { "/ws": { target: "ws://127.0.0.1:57320", ws: true } },
  },
});
