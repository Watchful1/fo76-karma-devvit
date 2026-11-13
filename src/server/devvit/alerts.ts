// Alerts to the moderators' Discord webhook. A missing or failing webhook is
// logged and otherwise ignored: the bot's work never depends on it.

import type { AlertPort } from '../types';

const TIMEOUT_MS = 5000;

/** Whether the setting holds a Discord webhook URL, the only place alerts may go. */
export function isDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'discord.com' &&
      parsed.pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

/** The request body: the text, cut to Discord's limit, with every kind of mention switched off. */
export function alertPayload(appName: string, message: string): string {
  return JSON.stringify({
    content: `[${appName}] ${message}`.slice(0, 1900),
    allowed_mentions: { parse: [] },
  });
}

export function discordAlerts(webhookUrl: string, appName: string): AlertPort {
  return {
    async send(message: string): Promise<void> {
      if (!webhookUrl) return;
      try {
        if (!isDiscordWebhook(webhookUrl)) {
          throw new Error(
            'the webhook setting is not a https://discord.com/api/webhooks/ URL'
          );
        }
        // Devvit's fetch ignores an abort signal, so the wait is bounded here.
        const response = await Promise.race([
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: alertPayload(appName, message),
          }),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error('Discord did not answer in time')),
              TIMEOUT_MS
            )
          ),
        ]);
        if (!response.ok)
          throw new Error(`Discord answered ${response.status}`);
      } catch (error) {
        console.error(`Alert not sent: ${String(error)}`);
      }
    },
  };
}
