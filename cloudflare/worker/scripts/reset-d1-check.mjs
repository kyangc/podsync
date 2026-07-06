import { rmSync } from "node:fs";

rmSync(".wrangler/d1-check", { recursive: true, force: true });
