import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const storageDir = path.join(rootDir, "storage");
const publicUrlFile = path.join(storageDir, "public-url.txt");
const port = 4173;

let serverProcess = null;
let tunnelProcess = null;
let shuttingDown = false;

await fs.mkdir(storageDir, { recursive: true });

try {
  await runBuild();
  const hasExistingServer = await hasHealthyServer(port);
  if (hasExistingServer) {
    console.log(`Reutilizando servidor existente en http://127.0.0.1:${port}`);
  } else {
    serverProcess = startServer();
  }
  await waitForHealth(`http://127.0.0.1:${port}/api/health`, 20_000);
  const publicUrl = await createTunnelWithRetry(8);
  await fs.writeFile(publicUrlFile, `${publicUrl}\n`, "utf8");

  console.log("");
  console.log("Servidor remoto listo.");
  console.log(`Link publico: ${publicUrl}`);
  console.log(`Copia local del link: ${publicUrlFile}`);
  console.log(`Guardado de JSONs: ${path.join(rootDir, "storage", "exports")}`);
  console.log("");
  console.log("Deja esta terminal abierta mientras tu amigo usa la web.");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const watchers = [waitForExit(tunnelProcess, "El tunel publico se cerro.")];
  if (serverProcess) {
    watchers.push(waitForExit(serverProcess, "El servidor local se cerro."));
  }

  await Promise.race(watchers);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await shutdown();
  process.exit(1);
}

async function runBuild() {
  if (process.platform === "win32") {
    await runCommand("cmd.exe", ["/d", "/s", "/c", "npm run build"], "No pude construir la app.");
    return;
  }

  await runCommand("npm", ["run", "build"], "No pude construir la app.");
}

function startServer() {
  const child = spawn(process.execPath, ["scripts/remote-review-server.mjs"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "0.0.0.0", PORT: String(port) },
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

function startTunnel() {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const child = spawn(executable, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  return child;
}

async function createTunnelWithRetry(maxAttempts) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    tunnelProcess = startTunnel();

    try {
      return await waitForTunnelUrl(tunnelProcess, 25_000);
    } catch (error) {
      lastError = error;

      try {
        tunnelProcess.kill("SIGTERM");
      } catch {
        // Ignorado.
      }

      if (attempt < maxAttempts) {
        const delayMs = Math.min(10_000, 1_500 * attempt);
        console.log(`Reintentando tunel publico (${attempt}/${maxAttempts}) en ${Math.round(delayMs / 1000)}s...`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error("No pude abrir el tunel publico.");
}

async function waitForTunnelUrl(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stderr = "";
  let stdout = "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("No pude obtener el link publico de Cloudflare Tunnel."));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = sanitizeTunnelOutput(chunk.toString());
      stdout += text;
      stderr += text;

      if (/failed to request quick Tunnel/i.test(text)) {
        cleanup();
        reject(new Error("Cloudflare no pudo crear el quick tunnel."));
        return;
      }

      const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)]
        .map((match) => match[0])
        .filter((url) => url.toLowerCase() !== "https://api.trycloudflare.com");

      if (matches.length) {
        cleanup();
        resolve(matches[0]);
      }
    };

    const onExit = () => {
      cleanup();
      reject(new Error(`Cloudflare Tunnel se cerro antes de entregar el link.\n${stdout || stderr}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);

    if (Date.now() > deadline) {
      cleanup();
      reject(new Error("Timeout esperando el tunel."));
    }
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Seguimos intentando.
    }

    await sleep(500);
  }

  throw new Error("El servidor local no respondio a tiempo.");
}

async function hasHealthyServer(targetPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}/api/health`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function runCommand(command, args, errorMessage) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorMessage));
    });
    child.on("error", () => reject(new Error(errorMessage)));
  });
}

function waitForExit(child, message) {
  return new Promise((_, reject) => {
    child.on("exit", () => reject(new Error(message)));
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of [tunnelProcess, serverProcess]) {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignorado.
      }
    }
  }

  await sleep(300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTunnelOutput(input) {
  return `${input || ""}`
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}
