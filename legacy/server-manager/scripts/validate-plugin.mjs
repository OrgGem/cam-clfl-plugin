import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const ajv = new Ajv({ strict: false });
addFormats(ajv);
for (const kind of ["plugin", "mcp"]) {
  const schema = JSON.parse(
    await readFile(
      new URL("../docs/" + kind + ".schema.json", import.meta.url),
      "utf8",
    ),
  );
  const data = JSON.parse(
    await readFile(
      new URL("../plugin/" + kind + ".json", import.meta.url),
      "utf8",
    ),
  );
  const check = ajv.compile(schema);
  if (!check(data)) throw Error(JSON.stringify(check.errors));
}
console.log("Plugin and MCP configuration match Agent Plugins 1.0.0 schemas.");
