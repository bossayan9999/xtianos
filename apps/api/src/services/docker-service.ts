import Docker from "dockerode";

let docker: Docker | null = null;

function client(): Docker {
  if (docker === null) {
    const host = process.env.DOCKER_HOST;
    if (host) {
      if (host.startsWith("unix://")) {
        docker = new Docker({ socketPath: host.slice("unix://".length) });
      } else if (host.startsWith("npipe://")) {
        docker = new Docker({ socketPath: host.slice("npipe://".length) || "//./pipe/docker_engine" });
      } else {
        const u = new URL(host);
        docker = new Docker({ host: u.hostname, port: Number(u.port || 80) });
      }
    } else {
      docker = new Docker({
        socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
      });
    }
  }
  return docker;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export async function listContainers(): Promise<ContainerInfo[]> {
  const containers = await client().listContainers({ all: true });
  return containers.map((c) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    status: c.Status,
  }));
}

async function withContainer(id: string, fn: (c: Docker.Container) => Promise<void>): Promise<string> {
  const container = client().getContainer(id);
  await fn(container);
  return `OK ${id}`;
}

export const dockerStart = (id: string) =>
  withContainer(id, (c) => c.start().then(() => undefined).catch(() => undefined));
export const dockerStop = (id: string) =>
  withContainer(id, (c) => c.stop().then(() => undefined).catch(() => undefined));
export const dockerRestart = async (id: string): Promise<string> => {
  await client().getContainer(id).restart();
  return `OK restarted ${id}`;
};

export async function dockerAvailable(): Promise<boolean> {
  try {
    await client().ping();
    return true;
  } catch {
    return false;
  }
}
