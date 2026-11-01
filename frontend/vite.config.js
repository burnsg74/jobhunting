import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:4002",
    },
  },
});
