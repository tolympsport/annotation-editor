import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Library build: two entry points (core + /tiptap), ESM output.
// All non-relative imports (react, tiptap, radix, lucide, …) stay external.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    lib: {
      entry: {
        index: path.resolve(import.meta.dirname, "src/index.ts"),
        tiptap: path.resolve(import.meta.dirname, "src/tiptap.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) => !id.startsWith(".") && !path.isAbsolute(id),
    },
  },
});
