const delay = Number(process.argv[2] ?? 0);
const value = process.argv[3] ?? "done";
setTimeout(() => {
  process.stdout.write(JSON.stringify({ additionalContext: value }));
}, delay);
