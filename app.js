require("dotenv").config();
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const ALLOWED_CHANNEL_ID = "C0AMQPF6XEV";

const UPLOAD_BURST_WINDOW_MS = 8000;
const recentUploadBursts = new Map();

const FIRST_REMINDER_DELAY_MS = 3 * 60 * 1000;
const REPEATED_REMINDER_DELAY_MS = 30 * 60 * 1000;

const pendingForms = new Map();

function getThreadTsFromFile(file, channelId) {
  const publicShares = file?.shares?.public?.[channelId];
  if (publicShares && publicShares.length > 0) {
    return publicShares[0].ts;
  }

  const privateShares = file?.shares?.private?.[channelId];
  if (privateShares && privateShares.length > 0) {
    return privateShares[0].ts;
  }

  return null;
}

function getTodayDateString() {
  return new Date().toISOString().split("T")[0];
}

function getBatchOptions() {
  const options = [];
  for (let i = 1; i <= 20; i++) {
    const value = String(i).padStart(3, "0");
    options.push({
      text: {
        type: "plain_text",
        text: value,
      },
      value,
    });
  }
  return options;
}

function buildBurstKey({ channelId, userId }) {
  return `${channelId}:${userId}`;
}

function shouldSkipBurstMessage({ channelId, userId }) {
  const key = buildBurstKey({ channelId, userId });
  const now = Date.now();
  const lastSeen = recentUploadBursts.get(key);

  if (lastSeen && now - lastSeen < UPLOAD_BURST_WINDOW_MS) {
    return true;
  }

  recentUploadBursts.set(key, now);

  setTimeout(() => {
    const currentValue = recentUploadBursts.get(key);
    if (currentValue === now) {
      recentUploadBursts.delete(key);
    }
  }, UPLOAD_BURST_WINDOW_MS + 1000);

  return false;
}

function buildReminderKey({ channelId, threadTs }) {
  return `${channelId}:${threadTs}`;
}

async function sendReminderDM(client, formState) {
  if (!formState || formState.completed) {
    return;
  }

  if (!formState.uploaderUserId) {
    console.error("Cannot send DM reminder: missing uploaderUserId");
    return;
  }

  try {
    console.log("Opening DM for user:", formState.uploaderUserId);

    const dm = await client.conversations.open({
      users: formState.uploaderUserId,
    });

    console.log("DM opened:", dm.channel.id);

    await client.chat.postMessage({
      channel: dm.channel.id,
      text:
        `Reminder: please fill in the image information form for your upload in <#${formState.channelId}>.\n` +
        `Open thread: https://slack.com/app_redirect?channel=${formState.channelId}&message_ts=${formState.threadTs}`,
    });

    console.log("DM reminder sent.");
  } catch (error) {
    console.error("DM reminder failed:", error?.data || error);
  }
}

function clearFormReminders(reminderKey) {
  const existing = pendingForms.get(reminderKey);

  if (!existing) {
    return;
  }

  if (existing.firstReminderTimeout) {
    clearTimeout(existing.firstReminderTimeout);
  }

  if (existing.repeatReminderInterval) {
    clearInterval(existing.repeatReminderInterval);
  }

  pendingForms.delete(reminderKey);
}

function scheduleFormReminders({
  client,
  reminderKey,
  uploaderUserId,
  channelId,
  threadTs,
}) {
  clearFormReminders(reminderKey);

  const formState = {
    uploaderUserId,
    channelId,
    threadTs,
    completed: false,
    firstReminderTimeout: null,
    repeatReminderInterval: null,
  };

  console.log("Scheduling first reminder for:", {
    reminderKey,
    uploaderUserId,
    channelId,
    threadTs,
  });

  formState.firstReminderTimeout = setTimeout(async () => {
    const current = pendingForms.get(reminderKey);
    if (!current || current.completed) {
      return;
    }

    console.log("First reminder timer fired for:", reminderKey);

    await sendReminderDM(client, current);

    current.repeatReminderInterval = setInterval(async () => {
      const latest = pendingForms.get(reminderKey);
      if (!latest || latest.completed) {
        return;
      }

      console.log("Repeated reminder timer fired for:", reminderKey);
      await sendReminderDM(client, latest);
    }, REPEATED_REMINDER_DELAY_MS);
  }, FIRST_REMINDER_DELAY_MS);

  pendingForms.set(reminderKey, formState);
}

app.event("file_shared", async ({ event, client, logger }) => {
  try {
    console.log("file_shared event received:", JSON.stringify(event, null, 2));

    const fileInfo = await client.files.info({
      file: event.file_id,
    });

    const file = fileInfo.file;

    if (!file || !file.mimetype || !file.mimetype.startsWith("image/")) {
      console.log("Ignored because not an image:", file?.mimetype);
      return;
    }

    const shares = file?.shares || {};
    const publicChannelIds = Object.keys(shares.public || {});
    const privateChannelIds = Object.keys(shares.private || {});
    const allChannelIds = [...publicChannelIds, ...privateChannelIds];

    if (!allChannelIds.includes(ALLOWED_CHANNEL_ID)) {
      console.log("Ignored because wrong channel. Shared in:", allChannelIds);
      return;
    }

    const channelId = ALLOWED_CHANNEL_ID;
    const threadTs = getThreadTsFromFile(file, channelId);

    if (!threadTs) {
      console.log("Could not determine thread ts for file:", event.file_id);

      await client.chat.postMessage({
        channel: channelId,
        text: "I found the image, but could not attach the form to the image thread.",
      });

      return;
    }

    const uploaderUserId = file.user || event.user_id;

    if (!uploaderUserId) {
      console.log("No uploader user ID found. Skipping reminder setup.");
      return;
    }

    if (
      shouldSkipBurstMessage({
        channelId,
        userId: uploaderUserId,
      })
    ) {
      console.log("Skipped duplicate burst message for:", uploaderUserId);
      return;
    }

    const reminderKey = buildReminderKey({
      channelId,
      threadTs,
    });

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "Please enter image information.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Image uploaded. Please add the required image information.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Enter image info",
              },
              action_id: "open_image_info_modal",
              value: JSON.stringify({
                channelId,
                fileId: event.file_id,
                threadTs,
                uploaderUserId,
                reminderKey,
              }),
            },
          ],
        },
      ],
    });

    scheduleFormReminders({
      client,
      reminderKey,
      uploaderUserId,
      channelId,
      threadTs,
    });

    console.log("Posted button message to thread:", threadTs);
    console.log("Reminders scheduled successfully for reminderKey:", reminderKey);
  } catch (error) {
    console.error("file_shared handler error:", error);
    logger.error(error);
  }
});

app.action("open_image_info_modal", async ({ ack, body, client, logger }) => {
  try {
    await ack();

    const data = JSON.parse(body.actions[0].value);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "submit_image_info",
        private_metadata: JSON.stringify(data),
        title: {
          type: "plain_text",
          text: "Image info",
        },
        submit: {
          type: "plain_text",
          text: "Save",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "input",
            block_id: "date_block",
            label: {
              type: "plain_text",
              text: "Date",
            },
            element: {
              type: "datepicker",
              action_id: "date_input",
              initial_date: getTodayDateString(),
            },
          },

          {
            type: "input",
            block_id: "room_block",
            label: {
              type: "plain_text",
              text: "Room",
            },
            element: {
              type: "static_select",
              action_id: "room_input",
              placeholder: {
                type: "plain_text",
                text: "Select room",
              },
              options: [
                { text: { type: "plain_text", text: "B1" }, value: "B1" },
                { text: { type: "plain_text", text: "B2" }, value: "B2" },
                { text: { type: "plain_text", text: "B3" }, value: "B3" },
                { text: { type: "plain_text", text: "B4" }, value: "B4" },
                { text: { type: "plain_text", text: "Mom" }, value: "Mom" },
                { text: { type: "plain_text", text: "Veg" }, value: "Veg" },
                { text: { type: "plain_text", text: "Water" }, value: "Water" },
              ],
            },
          },

          {
            type: "input",
            block_id: "table_block",
            label: {
              type: "plain_text",
              text: "Table",
            },
            element: {
              type: "static_select",
              action_id: "table_input",
              placeholder: {
                type: "plain_text",
                text: "Select table",
              },
              options: [
                {
                  text: {
                    type: "plain_text",
                    text: "Left",
                  },
                  value: "Left",
                },
                {
                  text: {
                    type: "plain_text",
                    text: "Right",
                  },
                  value: "Right",
                },
              ],
            },
          },

          {
            type: "input",
            block_id: "batch_block",
            label: {
              type: "plain_text",
              text: "Batch",
            },
            element: {
              type: "number_input",
              is_decimal_allowed: false,
              min_value: "0",
              action_id: "batch_input",
              placeholder: {
                type: "plain_text",
                text: "Enter numbers only",
              },
            },
          },

          {
            type: "input",
            optional: true,
            block_id: "comment_block",
            label: {
              type: "plain_text",
              text: "Additional Comment",
            },
            element: {
              type: "plain_text_input",
              multiline: true,
              action_id: "comment_input",
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error("open_image_info_modal error:", error?.data || error);
    logger.error(error);
  }
});

app.view("submit_image_info", async ({ ack, view, client, logger }) => {
  try {
    const meta = JSON.parse(view.private_metadata);
    const values = view.state.values;

    const date = values.date_block.date_input.selected_date;
    const room = values.room_block.room_input.selected_option.value;
    const table = values.table_block.table_input.selected_option.value;
    const batchNumber = values.batch_block.batch_input.value.trim();

    if (!/^[0-9]+$/.test(batchNumber)) {
      await ack({
        response_action: "errors",
        errors: {
          batch_block: "Batch must contain numbers only (do not include #)",
        },
      });
      return;
    }

    await ack();

    const batch = `#${batchNumber}`;
    const comment = values.comment_block?.comment_input?.value || "-";

    if (meta.reminderKey) {
      clearFormReminders(meta.reminderKey);
    }

    await client.chat.postMessage({
      channel: meta.channelId,
      thread_ts: meta.threadTs,
      text:
        `Image info saved\n` +
        `Date: ${date}\n` +
        `Room: ${room}\n` +
        `Table: ${table}\n` +
        `Batch: ${batch}\n` +
        `Additional Comment: ${comment}`,
    });
  } catch (error) {
    console.error("submit_image_info error:", error?.data || error);
    logger.error(error);
  }
});

(async () => {
  await app.start();
  console.log("⚡ Slack bot is running");
})();
