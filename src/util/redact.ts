/** 遮掉 Bark key（URL 路径段）与 Telegram bot token。 */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^/\s]+\/)[A-Za-z0-9]{16,}/g, "$1***")
    .replace(/bot[0-9]+:[A-Za-z0-9_-]{20,}/g, "bot***")
    .replace(/"deviceKey"\s*:\s*"[^"]*"/g, '"deviceKey":"***"')
    .replace(/([?&]device_key=)[^&\s"']+/g, "$1***");
}
