import esbuild from "esbuild";
import process from "process";

const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "browser",
  target: "es2018",
  external: ["obsidian"],
  sourcemap: isWatch ? "inline" : false,
  minify: !isWatch
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Vault Sync: watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
