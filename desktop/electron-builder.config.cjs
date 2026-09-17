// No update host is assumed. A release operator supplies an HTTPS feed explicitly.
const config = { ...require("./package.json").build };
if (process.env.TASKLINK_UPDATE_URL) {
  const feed = new URL(process.env.TASKLINK_UPDATE_URL);
  if (
    feed.protocol !== "https:" ||
    feed.username ||
    feed.password ||
    feed.search ||
    feed.hash
  ) {
    throw new Error(
      "TASKLINK_UPDATE_URL must be an HTTPS URL without credentials, query or fragment",
    );
  }
  const publisher = process.env.TASKLINK_PUBLISHER_NAME;
  const channel = process.env.TASKLINK_UPDATE_CHANNEL || "latest";
  if (!publisher || !/^[a-z][a-z0-9-]{0,31}$/.test(channel))
    throw new Error(
      "Signed updates require TASKLINK_PUBLISHER_NAME and a valid channel",
    );
  config.forceCodeSigning = true;
  config.win = { ...config.win, publisherName: [publisher] };
  config.publish = [
    {
      provider: "generic",
      url: feed.href,
      channel: process.env.TASKLINK_UPDATE_CHANNEL || "latest",
    },
  ];
  config.extraMetadata = {
    tasklinkUpdate: {
      url: feed.href,
      channel,
      publisher,
    },
  };
}
module.exports = config;
