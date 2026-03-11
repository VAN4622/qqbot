import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

const result = spawnSync("tsc", { stdio: "inherit", shell: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
