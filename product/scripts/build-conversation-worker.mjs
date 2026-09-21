import { build } from "esbuild";
const entries = [["scripts/run-conversation-worker.ts", ".runtime/conversation-worker.mjs"]];
if (process.argv.includes("--acceptance")) entries.push(["scripts/conversation-pg16-acceptance.ts", ".runtime/conversation-pg16-acceptance.mjs"]);
for (const [entry, outfile] of entries) await build({
  entryPoints: [entry], outfile,
  platform: "node", target: "node22", format: "esm", bundle: true, packages: "external",
  plugins: [{ name: "standalone-server", setup(builder) {
    builder.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "standalone" }));
    builder.onLoad({ filter: /.*/, namespace: "standalone" }, () => ({ contents: "", loader: "js" }));
  } }],
});
