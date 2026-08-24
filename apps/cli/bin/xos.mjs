#!/usr/bin/env node

const API = process.env["XTIANDOS_API"] ?? "http://localhost:3101";
const TOKEN = process.env["XTIANDOS_TOKEN"] ?? "";
const headers = { "Content-Type": "application/json", ...(TOKEN ? { "X-Auth-Token": TOKEN } : {}) };

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}`);
  return res.json();
}

async function ask(question) {
  const conversation = await api("/api/chat", { method: "POST", body: "{}" });
  const res = await fetch(`${API}/api/chat/${conversation.id}/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: question }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine && frame.includes("event: agent")) {
        try {
          const step = JSON.parse(dataLine.slice(6));
          if (step.type === "message") process.stdout.write(step.data);
          else if (step.type === "tool-start") console.error(`\n⚙ ${step.data.name}…`);
          else if (step.type === "error") console.error(`\n⚠️ ${step.data}`);
        } catch {}
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  console.log();
}

const [command, ...rest] = process.argv.slice(2);
const arg = rest.join(" ");

switch (command) {
  case "ask":
    if (!arg) { console.error("usage: xos ask <question>"); process.exit(1); }
    await ask(arg);
    break;
  case "tasks":
    console.table(await api("/api/tasks"));
    break;
  case "projects":
    console.table(await api("/api/projects"));
    break;
  case "brain":
    console.log(JSON.stringify(await api(`/api/memory/search?q=${encodeURIComponent(arg)}`), null, 2));
    break;
  case "docker":
    console.table(await api("/api/docker/containers"));
    break;
  default:
    console.log(`xos — xtiandOS companion

  xos ask <question>     talk to mjane (agent loop w/ tools)
  xos tasks              list workflow tasks
  xos projects           list projects
  xos brain <query>      search mjane's memory
  xos docker             list containers`);
}
