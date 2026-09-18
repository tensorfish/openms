import { parseFlags } from "../../client/tools/source-options.js";

if (import.meta.main) {
  try {
    const options = parseFlags(process.argv.slice(2), {
      url: { type: "string", default: "http://127.0.0.1:3197" },
      help: { type: "boolean" },
    });
    if (options.help) {
      console.log(
        "Usage: bun server/tools/playtest-doctor.js [--url ORIGIN]\nRead-only source/catalog/configuration check. Default: http://127.0.0.1:3197. Does not authenticate, drive a browser, start services or prove process ownership.",
      );
    } else {
      const { playtestDoctor } =
        await import("../../client/tools/scenarios/online-playtest.js");
      console.log(
        JSON.stringify(
          {
            status: "ready-for-browser-check",
            expectedIdentity: await playtestDoctor(options.url),
            browserSource: "not-checked",
            ownership: "not-checked",
            authentication: "not-checked",
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({ status: "blocked", message: error.message }),
    );
    process.exitCode = 2;
  }
}
