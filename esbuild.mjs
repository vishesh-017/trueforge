import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  external: ["vscode"],
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
  }),
  esbuild.context({
    ...shared,
    entryPoints: ["test/diff.test.ts", "test/retrieve.test.ts"],
    outdir: "dist-test",
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
