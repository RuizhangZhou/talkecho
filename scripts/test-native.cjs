const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Scope the Common Controls manifest to this test child process. Production
// Tauri binaries already embed their own manifest through resource.lib.
const result = spawnSync("cargo", ["test", "--lib", ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, "../src-tauri"),
  stdio: "inherit",
  env: {
    ...process.env,
    TALKECHO_TEST_MANIFEST: process.platform === "win32" ? "1" : "0",
  },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
