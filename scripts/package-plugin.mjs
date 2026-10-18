import { createHash } from "node:crypto";
import { build } from "esbuild";
import { zipSync } from "fflate";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
const root = resolve("."),
  dest = resolve("dist/marketplace"),
  plugin = join(dest, "plugin");
await rm(dest, { recursive: true, force: true });
await mkdir(plugin, { recursive: true });
for (const file of ["plugin.json", "mcp.json", "skills", "scripts"])
  await cp(join(root, "plugin", file), join(plugin, file), { recursive: true });
await mkdir(join(dest, ".agents/plugins"), { recursive: true });
const catalog = JSON.parse(
  await readFile(".agents/plugins/marketplace.json", "utf8"),
);
catalog.plugins[0].source = { source: "local", path: "./plugin" };
await writeFile(
  join(dest, ".agents/plugins/marketplace.json"),
  JSON.stringify(catalog, null, 2) + "\n",
);
const output = await build({
  entryPoints: ["apps/local/src/cli.ts"],
  outfile: join(plugin, "server/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@napi-rs/keyring"],
  banner: {
    js: 'import {createRequire as __gemCreateRequire} from "node:module"; const require=__gemCreateRequire(import.meta.url);',
  },
  metafile: true,
  legalComments: "eof",
});
await cp("dist/ui", join(plugin, "server/ui"), { recursive: true });
const modules = join(plugin, "server/node_modules/@napi-rs");
await mkdir(modules, { recursive: true });
await cp("node_modules/@napi-rs/keyring", join(modules, "keyring"), {
  recursive: true,
});
const keyring = JSON.parse(
  await readFile("node_modules/@napi-rs/keyring/package.json", "utf8"),
);
const supported = [
  "darwin-x64",
  "darwin-arm64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
  "linux-x64-gnu",
  "linux-arm64-gnu",
];
const cache = resolve("dist/package-cache");
await mkdir(cache, { recursive: true });
const native = [];
for (const target of supported) {
  const name = "@napi-rs/keyring-" + target,
    version = keyring.optionalDependencies[name];
  if (!version) throw Error("Unsupported native target " + target);
  const installed = resolve("node_modules", name),
    targetDir = join(modules, "keyring-" + target);
  try {
    await accessPackage(installed, name, version);
    await cp(installed, targetDir, { recursive: true });
  } catch {
    const raw = execFileSync(
      "npm",
      ["pack", name + "@" + version, "--pack-destination", cache, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const [pack] = JSON.parse(raw);
    await mkdir(targetDir, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      join(cache, pack.filename),
      "-C",
      targetDir,
      "--strip-components=1",
    ]);
    await accessPackage(targetDir, name, version);
  }
  native.push({ name, version, target });
}
async function accessPackage(dir, name, version) {
  const data = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (data.name !== name || data.version !== version)
    throw Error("Package identity mismatch");
}
const packages = new Map();
for (const path of Object.keys(output.metafile.inputs)) {
  const match = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.set(match[1], resolve("node_modules", match[1]));
}
packages.set("@napi-rs/keyring", resolve("node_modules/@napi-rs/keyring"));
let notices = "# Third-party packages\n\n";
for (const [name, dir] of packages) {
  const meta = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  notices += `## ${name} ${meta.version}\n\nLicense: ${meta.license ?? "See package metadata"}\n\n`;
  for (const filename of await readdir(dir)) {
    if (
      /^licen[cs]e(?:\.|$)/i.test(filename) &&
      (await stat(join(dir, filename))).isFile()
    )
      notices +=
        "```text\n" +
        (await readFile(join(dir, filename), "utf8")) +
        "\n```\n\n";
  }
}
await writeFile(join(plugin, "THIRD_PARTY_NOTICES.md"), notices);
await writeFile(
  join(plugin, "BUILD.json"),
  JSON.stringify(
    {
      version: JSON.parse(await readFile("plugin/plugin.json", "utf8")).version,
      requires_node: ">=22.12.0",
      native_targets: native,
      client_only: true,
    },
    null,
    2,
  ) + "\n",
);
const files = {};
async function collect(dir, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const key = prefix + item.name,
      path = join(dir, item.name);
    if (item.isDirectory()) await collect(path, key + "/");
    else if (item.isFile()) files[key] = new Uint8Array(await readFile(path));
    else throw Error("Unsupported package entry");
  }
}
await collect(dest);
await writeFile(
  "dist/gem-cloudflare-marketplace.zip",
  zipSync(files, { level: 6 }),
);
const pluginFiles = {};
for (const [name, bytes] of Object.entries(files))
  if (name.startsWith("plugin/")) pluginFiles[name.slice(7)] = bytes;
await writeFile(
  "dist/gem-cloudflare-plugin.zip",
  zipSync(pluginFiles, { level: 6 }),
);
let sums = "";
for (const name of [
  "gem-cloudflare-marketplace.zip",
  "gem-cloudflare-plugin.zip",
])
  sums +=
    createHash("sha256")
      .update(await readFile("dist/" + name))
      .digest("hex") +
    "  " +
    name +
    "\n";
await writeFile("dist/SHA256SUMS.txt", sums);
console.log(
  "Built self-contained client plugin and marketplace ZIPs for " +
    supported.join(", ") +
    ". Node must already be installed; public Directory submission still requires OpenAI approval.",
);
