import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import zipPack from "vite-plugin-zip-pack";

const isDev = process.env.NODE_ENV === "development";
const outputDir = isDev ? "dev" : "dist";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    svelte(),
    viteStaticCopy({
      targets: [
        { src: "./plugin.json", dest: "./" },
        { src: "./README*.md", dest: "./" },
        { src: "./docs", dest: "./" },
        { src: "./icon.png", dest: "./" },
        { src: "./preview.png", dest: "./" },
        { src: "./public/embed", dest: "./" }
      ],
    }),
    ...(!isDev ? [zipPack({ inDir: "./dist", outDir: "./", outFileName: "package.zip" })] : []),
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
  },
  build: {
    outDir: outputDir,
    emptyOutDir: true,
    minify: !isDev,
    sourcemap: isDev ? "inline" : false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      fileName: () => "index.js",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["siyuan", "process"],
      output: {
        entryFileNames: "index.js",
        assetFileNames: (assetInfo) => assetInfo.name === "style.css" ? "index.css" : (assetInfo.name ?? "[name][extname]"),
      },
    },
  },
});
