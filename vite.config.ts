import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";

const isDev = process.env.NODE_ENV === "development";
const outputDir = isDev ? "dev" : "dist";

export default defineConfig({
  plugins: [
    svelte(),
    viteStaticCopy({
      targets: [
        { src: "./plugin.json", dest: "./" },
        { src: "./README*.md", dest: "./" },
      ],
    }),
  ],

  build: {
    outDir: outputDir,
    emptyOutDir: true,
    minify: !isDev,
    sourcemap: process.env.VITE_SOURCEMAP === "inline" ? "inline" : false,

    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      fileName: () => "index.js",
      formats: ["cjs"],
    },

    rollupOptions: {
      external: ["siyuan", "process"],

      output: {
        entryFileNames: "index.js",
        assetFileNames: (assetInfo) =>
          assetInfo.name === "style.css"
            ? "index.css"
            : assetInfo.name ?? "[name][extname]",
      },
    },
  },
});
