// Isolated installer identity: never replaces a user's installed TaskLink.
const version = process.env.TASKLINK_VALIDATION_VERSION;
if (!/^[1-9]\d*\.\d+\.\d+$/.test(version ?? ""))
  throw new Error("Explicit validation version required");
module.exports = {
  ...require("../package.json").build,
  appId: "com.tasklink.installvalidation",
  productName: "TaskLink Validation",
  directories: { output: "release/install-validation/" + version },
  extraMetadata: { version },
  win: { ...require("../package.json").build.win, executableName: "TaskLink" },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    uninstallDisplayName: "TaskLink Validation",
  },
};
