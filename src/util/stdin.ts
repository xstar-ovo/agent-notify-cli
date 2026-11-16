/**
 * 在硬超时内从 stdin 读 hook JSON。
 * 绝不等待 EOF：有的 Agent 不关管道，等下去会把 hook 挂死。
 */
export function readStdinJson(ms = 300): Promise<unknown | undefined> {
  if (process.stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
      try {
        resolve(buf.trim() ? JSON.parse(buf) : undefined);
      } catch {
        resolve(undefined);
      }
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.length > 64_000) finish();
    };
    const timer = setTimeout(finish, ms);
    process.stdin.on("data", onData);
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}
