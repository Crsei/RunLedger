let input = "";
for await (const chunk of process.stdin) input += chunk;
const envelope = JSON.parse(input);
const toolName = envelope.payload?.toolName;
if (toolName === "Bash") {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: "fixture denies Bash" }));
} else {
  process.stdout.write(JSON.stringify({ decision: "allow", updatedInput: { path: "README.md" }, additionalContext: "fixture checked" }));
}
