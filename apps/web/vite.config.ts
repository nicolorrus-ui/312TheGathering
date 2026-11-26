import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const manaAssets = new URL("../client-qt/qml/assets/mana/", import.meta.url);

export default defineConfig({
  plugins: [{
    name: "mana-font-license",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "assets/mana-OFL.txt", source: readFileSync(new URL("OFL.txt", manaAssets)) });
    },
  }],
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../client-qt/qml/assets/card-back.jpg", import.meta.url)), fileURLToPath(manaAssets)] },
    proxy: {
      "/ws": { target: "ws://127.0.0.1:57320", ws: true },
      "/forge-ready": "http://127.0.0.1:57320",
      "/live-rooms": "http://127.0.0.1:57320",
      "/assets/deck-cards.json": "http://127.0.0.1:57320",
      "/card-search": "http://127.0.0.1:57320",
      "/card-art": "http://127.0.0.1:57320",
    },
  },
});
